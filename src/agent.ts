import { ChatOpenAI } from '@langchain/openai'
import { ChatOllama } from '@langchain/ollama'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { Config, AssertionResult, PageSelectors } from './types.js'

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

const SELECTOR_SYSTEM_PROMPT = `
You are an expert browser automation engineer. Your job is to map natural language element 
descriptions to CSS selectors by carefully reasoning about a simplified page DOM.

## How to reason about the DOM

The DOM you receive is a stripped-down snapshot of only the interactive and meaningful elements 
on the page (inputs, buttons, links, labels, headings). Use it to understand the PAGE CONTEXT 
first before resolving individual elements.

Step 1 — Understand the page:
- What kind of page is this? (login, signup, dashboard, checkout, settings, etc.)
- How many inputs are there? If there are only 2 inputs, the first is almost certainly a 
  username/email/identifier field and the second is a password field — even if they have 
  no labels or placeholder text.
- What are the primary actions on this page? (submit, sign in, next, pay, etc.)
- Are there any landmarks like headings, nav items, or labels that give context?

Step 2 — Match each description to an element:
- Use semantic reasoning, not just keyword matching.
- "email field" on a login page with 2 inputs = the first input, regardless of its attributes.
- "password field" = any input[type=password], or the second input if no type is set.
- "submit button" / "sign in button" / "login button" = the primary form action button.
- "store name field" on a login page likely means the first input (identifier/username).
- If a description is ambiguous, pick the most contextually appropriate element.
- Prefer specific attributes in this order: id > name > data-testid > aria-label > 
  placeholder > type > tag+position.

Step 3 — Provide multiple selector options:
- Give 2-3 selectors per element, from most specific to most general.
- This allows the runner to try fallbacks if the primary selector fails.
- Example: ["#email", "input[type=email]", "form input:first-of-type"]

## Output format

Return ONLY a valid JSON object — no markdown fences, no explanation, no preamble.
Keys are the original element descriptions exactly as given.
Values are arrays of CSS selectors ordered from most specific to most general.

Example:
{
  "store name / email field": ["#username", "input[name=email]", "form input:first-of-type"],
  "the password field": ["input[type=password]", "input[name=password]", "form input:nth-of-type(2)"],
  "the submit button": ["button[type=submit]", "button.login-btn", "form button:last-of-type"]
}
`.trim()

const ASSERTION_SYSTEM_PROMPT = `
You are a senior QA engineer evaluating whether a web page meets test assertions.
You are given a simplified DOM snapshot of the current page state and a list of assertions 
written in plain English.

## How to reason about assertions

Step 1 — Understand the current page state:
- What page are we on? Look at headings, navigation, and visible content.
- What has just happened? (user logged in, form submitted, item added to cart, etc.)
- What is visible vs hidden? Only elements present in the DOM snapshot count as visible.

Step 2 — Evaluate each assertion independently:
- Read the assertion carefully and decide what evidence you need to confirm or deny it.
- Look for that evidence in the DOM — text content, element presence, URLs, labels, values.
- Be practical: "welcome message is visible" passes if ANY greeting text or user name appears,
  even if the exact wording differs from what the assertion implies.
- Be strict about negative assertions: "no error messages should be visible" fails if ANY 
  element that looks like an error, alert, or warning is present in the DOM.
- For URL-based assertions, use the URL line at the top of the DOM if provided.
- If something is genuinely ambiguous or not enough information is available, fail it and
  explain what was missing.

Step 3 — Write a clear reason:
- For passes: briefly state what you found that confirms it.
- For failures: state exactly what was missing, wrong, or contradictory.

## Output format

Return ONLY a JSON array — no markdown, no explanation outside the array.
[
  { "assertion": "exact assertion text", "passed": true,  "reason": "Found <h1>Welcome, selenium_store</h1> in the top nav" },
  { "assertion": "exact assertion text", "passed": false, "reason": "No confirmation element found. Page still shows the login form." }
]
`.trim()

export class Agent {
  private model: BaseChatModel

  constructor(config: Config) {
    this.model = createModel(config)
  }

  async resolveBatchSelectors(targets: string[], dom: string): Promise<PageSelectors> {
    console.log(`[DEBUG-AGENT] Batch resolving ${targets.length} selectors in ONE call`)
    targets.forEach((t, i) => console.log(`[DEBUG-AGENT]   ${i + 1}. "${t}"`))
    console.log(`[DEBUG-AGENT] DOM preview (first 800 chars):\n${dom.substring(0, 800)}...`)

    const targetsText = targets.map((t, i) => `${i + 1}. ${t}`).join('\n')

    const response = await this.model.invoke([
      new SystemMessage(SELECTOR_SYSTEM_PROMPT),
      new HumanMessage(
        `PAGE DOM:\n${dom}\n\n` +
        `Resolve CSS selectors for these elements:\n${targetsText}\n\n` +
        `Return ONLY the JSON object with the selectors.`
      ),
    ])

    const text = (response.content as string).trim().replace(/```json|```/g, '').trim()
    console.log(`[DEBUG-AGENT] Raw selector response:\n${text}`)

    try {
      const result = JSON.parse(text) as PageSelectors
      console.log(`[DEBUG-AGENT] Resolved selectors:`)
      Object.entries(result).forEach(([target, selectors]) => {
        console.log(`[DEBUG-AGENT]   "${target}": [${(selectors as string[]).map(s => `"${s}"`).join(', ')}]`)
      })
      return result
    } catch (err) {
      throw new Error(`Failed to parse selector response: ${text}`)
    }
  }

  async evaluateAssertions(assertions: string[], dom: string): Promise<AssertionResult[]> {
    console.log(`[DEBUG-AGENT] Evaluating ${assertions.length} assertions`)
    assertions.forEach((a, i) => console.log(`[DEBUG-AGENT]   ${i + 1}. ${a}`))
    console.log(`[DEBUG-AGENT] DOM preview (first 500 chars):\n${dom.substring(0, 500)}...`)

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
    console.log(`[DEBUG-AGENT] Raw assertion response:\n${text}`)

    const results = JSON.parse(text) as AssertionResult[]
    results.forEach(r => {
      const icon = r.passed ? '✓' : '✗'
      console.log(`[DEBUG-AGENT]   ${icon} "${r.assertion}" — ${r.reason}`)
    })
   return results
  }

  // Converts raw element attribute strings into clean natural language descriptions
  // Used by the recorder to humanize captured interactions
  async describeElements(rawDescriptions: string[]): Promise<Record<string, string>> {
    const response = await this.model.invoke([
      new SystemMessage(
        'You are a QA engineer writing human-readable test descriptions. ' +
        'Given a list of raw element identifiers (ids, placeholders, text, class names), ' +
        'convert each into a short, clear natural language description a person would use.\n' +
        'Rules:\n' +
        '- Keep it short (2-5 words)\n' +
        '- Describe what the element IS, not its technical name\n' +
        '- Examples: "email-input" → "email input field", "btn-submit" → "submit button", ' +
        '"#nav-inventory" → "inventory menu item"\n' +
        'Return ONLY a JSON object — keys are the original strings, values are descriptions.'
      ),
      new HumanMessage(
        `Convert these to natural language:\n` +
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
}                        // ← class ends here ✓