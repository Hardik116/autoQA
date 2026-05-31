import { ChatOpenAI } from '@langchain/openai'
import { ChatOllama } from '@langchain/ollama'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { SupervisorAgent } from './supervisor.js'
import { SelectorAgent } from './selector.js'
import type { Config, AssertionResult, PageSelectors } from '../types.js'

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

const ASSERTION_SYSTEM_PROMPT = `
You are a senior QA engineer evaluating whether a web page meets test assertions.
You receive a simplified DOM snapshot and a list of plain English assertions.

## How to evaluate

Step 1 — Understand the current page state:
- What page are we on? Look at headings, nav, visible content.
- What has just happened? (logged in, form submitted, item created, etc.)

Step 2 — Evaluate each assertion independently:
- Find evidence in the DOM to confirm or deny it.
- Be practical about passes: "welcome message visible" passes if ANY greeting or 
  username text is present, even if wording differs.
- Be strict about negatives: "no error messages" fails if ANY error/alert element exists.
- For URL assertions, look for the URL line if present in the DOM context.

Step 3 — Give a clear reason:
- Pass: what you found that confirms it
- Fail: exactly what was missing or wrong

## Output format

Return ONLY a JSON array, no markdown.
[
  { "assertion": "...", "passed": true, "reason": "Found <h1>Welcome, selenium_store</h1>" },
  { "assertion": "...", "passed": false, "reason": "No confirmation element found, form still visible" }
]
`.trim()

// The orchestrator owns all agents and exposes a clean interface to the runner
export class Orchestrator {
  private model:     BaseChatModel
  private supervisor: SupervisorAgent
  private selector:   SelectorAgent

  constructor(config: Config) {
    this.model      = createModel(config)
    this.supervisor = new SupervisorAgent(this.model)
    this.selector   = new SelectorAgent(this.model)
  }

  // Two-step: supervisor understands → selector finds
  async resolveBatchSelectors(
    targets: string[],
    pageName: string,
    dom: string
  ): Promise<PageSelectors> {
    console.log(`[ORCHESTRATOR] Starting two-agent selector resolution`)
    console.log(`[ORCHESTRATOR] Step 1 — Supervisor analyzing targets...`)

    const intents = await this.supervisor.analyzeTargets(targets, pageName)

    console.log(`[ORCHESTRATOR] Step 2 — Selector agent finding elements in DOM...`)
    const selectors = await this.selector.resolveSelectors(intents, dom)

    console.log(`[ORCHESTRATOR] Resolution complete`)
    return selectors
  }

  // Assertion evaluation stays in the orchestrator (single agent, no need to split)
  async evaluateAssertions(assertions: string[], dom: string): Promise<AssertionResult[]> {
    console.log(`[ORCHESTRATOR] Evaluating ${assertions.length} assertion(s)`)

    const response = await this.model.invoke([
      new SystemMessage(ASSERTION_SYSTEM_PROMPT),
      new HumanMessage(
        `CURRENT PAGE DOM:\n${dom}\n\n` +
        `Evaluate these assertions:\n` +
        assertions.map((a, i) => `${i + 1}. ${a}`).join('\n') +
        `\n\nReturn ONLY the JSON array.`
      ),
    ])

    const text = (response.content as string).trim().replace(/```json|```/g, '').trim()
    const results = JSON.parse(text) as AssertionResult[]

    results.forEach(r => {
      const icon = r.passed ? '✓' : '✗'
      console.log(`[ORCHESTRATOR]   ${icon} "${r.assertion}"`)
      if (!r.passed) console.log(`[ORCHESTRATOR]     → ${r.reason}`)
    })

    return results
  }

  // Used by recorder to humanize raw element descriptions
  async describeElements(rawDescriptions: string[]): Promise<Record<string, string>> {
    const response = await this.model.invoke([
      new SystemMessage(
        'Convert raw HTML element identifiers into short natural language descriptions (2-5 words each). ' +
        'Return ONLY a JSON object — keys are originals, values are descriptions. No markdown.'
      ),
      new HumanMessage(
        rawDescriptions.map((d, i) => `${i + 1}. ${d}`).join('\n') +
        '\n\nReturn ONLY the JSON object.'
      ),
    ])

    const text = (response.content as string).trim().replace(/```json|```/g, '').trim()
    try {
      return JSON.parse(text) as Record<string, string>
    } catch {
      return Object.fromEntries(rawDescriptions.map(d => [d, d]))
    }
  }
}