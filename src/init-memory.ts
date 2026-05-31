import { ChatOpenAI } from '@langchain/openai'
import { ChatOllama } from '@langchain/ollama'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { crawlCodebase, type ExtractedElement } from './crawler.js'
import { MemoryStore } from './memory.js'
import type { Config } from './types.js'

type DescribedElement = {
  target: string
  pageName: string
  selector: string
  sourceFile: string
}

function createModel(config: Config): ChatOpenAI | ChatOllama {
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

const DESCRIBE_SYSTEM = `You are a QA engineer. Given HTML elements from a codebase, 
write a short natural language description (2-5 words) for each one that a tester would use.
Also infer the page name from the source file path (e.g. "login.pages.html" → "login").
Return a JSON array only — no markdown, no explanation.
Format: [{"target":"...","pageName":"...","selector":"...","sourceFile":"..."}]`

const FIX_JSON_SYSTEM = `You are a JSON repair specialist. 
You receive broken or malformed JSON and return ONLY the fixed valid JSON.
Do not add any explanation. Do not wrap in markdown. Return raw JSON only.`

// Step 1 — ask main model to describe elements
async function callDescribe(
  batch: ExtractedElement[],
  model: BaseChatModel
): Promise<string> {
  // Try withStructuredOutput first — works with Gemini 2.0 Flash Lite + paid models
  try {
    const structured = (model as any).withStructuredOutput({
      type: 'array',
      items: {
        type: 'object',
        properties: {
          target:     { type: 'string' },
          pageName:   { type: 'string' },
          selector:   { type: 'string' },
          sourceFile: { type: 'string' },
        },
        required: ['target', 'pageName', 'selector', 'sourceFile'],
      },
    })
    const result = await structured.invoke([
      new SystemMessage(DESCRIBE_SYSTEM),
      new HumanMessage(
        batch.map((e, i) =>
          `${i + 1}. file:${e.sourceFile} | type:${e.elementType} | selector:${e.selector} | raw:${e.rawHtml.slice(0, 100)}`
        ).join('\n') + '\n\nReturn the JSON array only.'
      ),
    ])
    // structured output returns parsed object directly — serialize back for unified handling
    return JSON.stringify(result)
  } catch {
    // Model doesn\'t support structured output — fall back to plain invoke
    const response = await model.invoke([
      new SystemMessage(DESCRIBE_SYSTEM),
      new HumanMessage(
        batch.map((e, i) =>
          `${i + 1}. file:${e.sourceFile} | type:${e.elementType} | selector:${e.selector} | raw:${e.rawHtml.slice(0, 100)}`
        ).join('\n') + '\n\nReturn the JSON array only.'
      ),
    ])
    return (response.content as string).trim()
  }
}

// Step 2 — if parsing fails, send broken output to a second LLM call to fix it
async function fixJSON(brokenText: string, model: BaseChatModel): Promise<string> {
  console.log(`    → Sending to JSON fixer LLM...`)
  const response = await model.invoke([
    new SystemMessage(FIX_JSON_SYSTEM),
    new HumanMessage(
      `Fix this broken JSON and return only the valid JSON array:\n\n${brokenText}`
    ),
  ])
  return (response.content as string)
    .trim()
    .replace(/```json|```/gi, '')
    .trim()
}

// Try to parse — extract [ ... ] block first to handle extra text
function tryParse(text: string): DescribedElement[] | null {
  const start = text.indexOf('[')
  const end   = text.lastIndexOf(']')
  if (start === -1 || end === -1 || end <= start) return null

  try {
    return JSON.parse(text.slice(start, end + 1)) as DescribedElement[]
  } catch {
    return null
  }
}

async function describeBatch(
  batch: ExtractedElement[],
  model: BaseChatModel
): Promise<DescribedElement[]> {
  // Attempt 1 — normal describe call
  const raw = await callDescribe(batch, model)
  const parsed = tryParse(raw)
  if (parsed) return parsed

  // Attempt 2 — dedicated JSON fixer LLM call
  try {
    const fixed   = await fixJSON(raw, model)
    const parsed2 = tryParse(fixed)
    // only use fixer result if it actually recovered data (not empty array)
    if (parsed2 && parsed2.length > 0) return parsed2
    if (parsed2 && parsed2.length === 0) {
      console.log(`    → Fixer returned empty array, using raw fallback`)
    }
  } catch {
    // fixer also failed
  }

  // Hard fallback — build from raw crawler data, no LLM needed
  console.log(`    → Using raw fallback descriptions`)
  return batch.map(e => ({
    target:     e.description,
    pageName:   e.sourceFile.split('/').slice(-2, -1)[0]?.replace(/\.\w+$/, '') ?? 'unknown',
    selector:   e.selector,
    sourceFile: e.sourceFile,
  }))
}

async function describeAllElements(
  elements: ExtractedElement[],
  model: BaseChatModel,
  batchSize = 10
): Promise<DescribedElement[]> {
  const results: DescribedElement[] = []
  const total = elements.length

  for (let i = 0; i < total; i += batchSize) {
    const batch = elements.slice(i, i + batchSize)
    const end   = Math.min(i + batchSize, total)
    process.stdout.write(`  Batch ${i + 1}–${end} of ${total}... `)

    const described = await describeBatch(batch, model)
    results.push(...described)
    console.log(`✓ ${described.length} saved`)
  }

  return results
}

export async function initMemory(srcDir: string, config: Config): Promise<void> {
  console.log('\n  promptest init-memory')
  console.log('  ──────────────────────────────────────────')
  console.log(`  Source dir : ${srcDir}`)
  console.log('  ──────────────────────────────────────────\n')

  const elements = await crawlCodebase(srcDir)
  if (!elements.length) {
    console.log('  No elements found. Check your --src path.\n')
    return
  }

  console.log(`\n  Found ${elements.length} elements. Describing in batches of 10...\n`)

  const model     = createModel(config)
  const described = await describeAllElements(elements, model)

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