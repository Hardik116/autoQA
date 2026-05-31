import path from 'path'
import { mkdirSync } from 'fs'
import { ChatOpenAI } from '@langchain/openai'
import { ChatOllama } from '@langchain/ollama'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { MasterAgent } from './agents/master.js'
import { AgentTools } from './agents/tools.js'
import { BrowserSession } from './browser.js'
import { MemoryStore } from './memory.js'
import { parsePromptFile } from './parser.js'
import { printResults } from './reporter.js'
import type { Config, TestResult, PageResult, AssertionResult } from './types.js'

const SCREENSHOT_DIR = '.promptest/screenshots'

function createModel(config: Config): BaseChatModel {
  if (config.provider === 'ollama') {
    return new ChatOllama({
      model: config.model,
      baseUrl: config.ollamaUrl ?? 'http://localhost:11434',
    })
  }
  return new ChatOpenAI({
    modelName: config.model,
    openAIApiKey: config.apiKey ?? process.env.OPENROUTER_API_KEY ?? '',
    configuration: {
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        'HTTP-Referer': 'https://github.com/promptest/promptest',
        'X-Title': 'promptest',
      },
    },
  })
}

export async function runTest(filePath: string, config: Config): Promise<TestResult> {
  const start = Date.now()
  console.log(`\n[RUNNER] ═══════════════════════════════════`)
  console.log(`[RUNNER] Starting: ${filePath}`)

  // Load memory
  const memory = new MemoryStore()
  await memory.load()

  const browser = new BrowserSession()
  const model   = createModel(config)

  let prompt
  try {
    prompt = await parsePromptFile(filePath)
    console.log(`[RUNNER] "${prompt.name}" — ${prompt.pages.length} page block(s)`)
  } catch (err) {
    return {
      file: filePath, name: filePath, passed: false,
      durationMs: Date.now() - start, pageResults: [],
      error: (err as Error).message,
    }
  }

  const baseUrl = prompt.baseUrl ?? config.baseUrl
  await browser.launch(config.headless)

  const tools  = new AgentTools(browser, memory, baseUrl)
  const agent  = new MasterAgent(model, tools, config.srcDir ?? '.')
  const pageResults: PageResult[] = []

  try {
    for (const [idx, page] of prompt.pages.entries()) {
      console.log(`\n[RUNNER] ── Page block ${idx + 1}/${prompt.pages.length}: "${page.name}"`)

      // Execute each step autonomously
      for (const step of page.steps) {
        const result = await agent.executeStep(step, page.name)
        if (!result.success) {
          mkdirSync(SCREENSHOT_DIR, { recursive: true })
          const safeName = page.name.replace(/[^a-z0-9]/gi, '-').toLowerCase()
          const screenshotPath = path.join(SCREENSHOT_DIR, `${safeName}-step-fail.png`)
          await browser.screenshot(screenshotPath)

          pageResults.push({
            pageName: page.name,
            assertions: [],
            passed: false,
            screenshotPath,
          })

          return {
            file: filePath, name: prompt.name, passed: false,
            durationMs: Date.now() - start, pageResults,
            error: `Step failed on "${page.name}": ${result.message}`,
          }
        }
      }

      // Evaluate assertions for this page
      if (page.verify.length > 0) {
        console.log(`\n[RUNNER] Verifying "${page.name}" (${page.verify.length} assertion(s))`)

        const assertions: AssertionResult[] = []
        for (const assertion of page.verify) {
          const result = await agent.evaluateAssertion(assertion, page.name)
          assertions.push({ assertion, ...result })
        }

        const passed = assertions.every(a => a.passed)

        let screenshotPath: string | undefined
        if (!passed) {
          mkdirSync(SCREENSHOT_DIR, { recursive: true })
          const safeName = page.name.replace(/[^a-z0-9]/gi, '-').toLowerCase()
          screenshotPath = path.join(SCREENSHOT_DIR, `${safeName}-verify-fail.png`)
          await browser.screenshot(screenshotPath)
        }

        pageResults.push({ pageName: page.name, assertions, passed, screenshotPath })

        if (!passed) {
          return {
            file: filePath, name: prompt.name, passed: false,
            durationMs: Date.now() - start, pageResults,
          }
        }

        console.log(`[RUNNER] "${page.name}" verified ✓`)
      }
    }

    // Persist memory after successful run
    await memory.save()

    return {
      file: filePath, name: prompt.name, passed: true,
      durationMs: Date.now() - start, pageResults,
    }

  } catch (err) {
    await memory.save()
    return {
      file: filePath, name: prompt.name, passed: false,
      durationMs: Date.now() - start, pageResults,
      error: (err as Error).message,
    }
  } finally {
    await browser.close()
  }
}