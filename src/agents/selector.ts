import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { SearchIntent } from './supervisor.js'
import type { PageSelectors } from '../types.js'

const SYSTEM_PROMPT = `
You are a DOM specialist. You receive structured search intents from a 
QA architect and a real page DOM snapshot. Your only job is to find 
the best CSS selectors for each element.

You do NOT interpret plain English. You receive precise instructions:
- What type of element to find
- What its purpose is  
- Where it is likely positioned
- What attributes to look for

## How to find selectors

For each search intent, scan the DOM and find the best matching element.
Use the attribute hints as your primary guide.

Priority order for selectors (most specific → most general):
1. data-testid attribute  →  [data-testid="..."]
2. id attribute           →  #elementId
3. name attribute         →  [name="..."]
4. aria-label             →  [aria-label="..."]
5. type + position        →  input[type=email], form input:first-of-type
6. role                   →  [role="button"]
7. text content           →  button:has-text (only if unique)
8. positional fallback    →  form input:nth-of-type(2)

Always return 2-3 selectors per element ordered from most to least specific.
The runner will try them in order and use the first one that works.

If an element is clearly not in the DOM, return an empty array [] for it.

## Output format

Return ONLY a JSON object — keys are the original target descriptions, 
values are arrays of CSS selectors. No markdown, no explanation.

{
  "store name / email field": ["#email", "input[type=email]", "form input:first-of-type"],
  "the submit button": ["button[type=submit]", "#login-btn", "form button:last-of-type"]
}
`.trim()

export class SelectorAgent {
  constructor(private model: BaseChatModel) {}

  async resolveSelectors(intents: SearchIntent[], dom: string): Promise<PageSelectors> {
    console.log(`[SELECTOR] Resolving ${intents.length} selector(s) from DOM`)

    // Format intents as a clear structured brief for the selector agent
    const intentsBrief = intents.map((intent, i) =>
      `${i + 1}. Target: "${intent.target}"\n` +
      `   Element type : ${intent.elementType}\n` +
      `   Purpose      : ${intent.purpose}\n` +
      `   Position     : ${intent.likelyPosition}\n` +
      `   Look for     : ${intent.attributeHints.join(', ')}`
    ).join('\n\n')

    const response = await this.model.invoke([
      new SystemMessage(SYSTEM_PROMPT),
      new HumanMessage(
        `PAGE DOM:\n${dom}\n\n` +
        `SEARCH INTENTS:\n${intentsBrief}\n\n` +
        `Return the JSON object with selectors for each target.`
      ),
    ])

    const text = (response.content as string).trim().replace(/```json|```/g, '').trim()
    console.log(`[SELECTOR] Raw response: ${text}`)

    try {
      const selectors = JSON.parse(text) as PageSelectors
      for (const [target, sels] of Object.entries(selectors)) {
        console.log(`[SELECTOR]   "${target}": [${(sels as string[]).join(', ')}]`)
      }
      return selectors
    } catch {
      throw new Error(`Selector agent failed to parse: ${text}`)
    }
  }
}