import { ChatOpenAI } from '@langchain/openai'
import { ChatOllama } from '@langchain/ollama'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { crawlCodebase, type ExtractedElement } from './crawler.js'
import { MemoryStore } from './memory.js'
import type { Config } from './types.js'
import path from 'path'

function createModel(config: Config): BaseChatModel {
  if (config.provider === 'ollama') {
    return new ChatOllama({ model: config.model, baseUrl: config.ollamaUrl ?? 'http://localhost:11434' })
  }
  return new ChatOpenAI({
    modelName: config.model,
    openAIApiKey: config.apiKey ?? process.env.OPENROUTER_API_KEY ?? '',
    configuration: {
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: { 'HTTP-Referer': 'https://github.com/promptest/promptest', 'X-Title': 'promptest' },
    },
  })
}

// Batch-describe elements in groups to minimize LLM calls
async function describeElements(
  elements: ExtractedElement[],
  model: BaseChatModel,
  batchSize = 20
): Promise<Array<{ target: string; pageName: string; selector: string; sourceFile: string }>> {
  const results = []

  for (let i = 0; i < elements.length; i += batchSize) {
    const batch = elements.slice(i, i + batchSize)
    console.log(`  Describing elements ${i + 1}–${Math.min(i + batchSize, elements.length)} of ${elements.length}...`)

    const response = await model.invoke([
      new SystemMessage(
        'You are a QA engineer. Given a list of HTML elements (with their source file and rough description), ' +
        'write a natural language description for each one that a tester would use to refer to it. ' +
        'Also infer the page name from the source file path. ' +
        'Return ONLY a JSON array, no markdown.\n' +
        'Format: [{"target": "natural description", "pageName": "login", "selector": "...", "sourceFile": "..."}]'
      ),
      new HumanMessage(
        `Elements:\n` +
        batch.map((e, idx) =>
          `${idx + 1}. file: ${e.sourceFile}\n   type: ${e.elementType}\n   raw: ${e.rawHtml.slice(0, 150)}\n   selector: ${e.selector}`
        ).join('\n\n') +
        `\n\nReturn the JSON array.`
      ),
    ])

    const text = (response.content as string).trim().replace(/```json|```/g, '').trim()
    try {
      const parsed = JSON.parse(text) as Array<{
        target: string; pageName: string; selector: string; sourceFile: string
      }>
      results.push(...parsed)
    } catch {
      console.log(`  Warning: could not parse batch ${i}–${i + batchSize}, skipping`)
    }
  }

  return results
}

export async function initMemory(srcDir: string, config: Config): Promise<void> {
  console.log('\n  promptest init-memory')
  console.log('  ──────────────────────────────────────────')
  console.log(`  Source dir : ${srcDir}`)
  console.log('  ──────────────────────────────────────────\n')

  // Step 1 — crawl the codebase
  const elements = await crawlCodebase(srcDir)

  if (!elements.length) {
    console.log('  No interactive elements found. Check your --src path.\n')
    return
  }

  console.log(`\n  Found ${elements.length} elements. Generating natural language descriptions...\n`)

  // Step 2 — batch describe with AI
  const model = createModel(config)
  const described = await describeElements(elements, model)

  // Step 3 — save to memory
  const memory = new MemoryStore()
  await memory.load()
  memory.bulk_insert(described)
  await memory.save()

  const stats = memory.stats()
  console.log('\n  ──────────────────────────────────────────')
  console.log(`  ✓ Memory initialized`)
  console.log(`    Total selectors : ${stats.total}`)
  console.log(`    From source     : ${stats.source}`)
  console.log(`    Saved to        : .promptest/memory.json`)
  console.log('\n  Run your tests — the agent will start with a warm cache.\n')
}