import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'

// What the supervisor produces for each target
export interface SearchIntent {
  target: string           // original plain english description
  elementType: string      // what kind of element it likely is
  purpose: string          // what it's used for on this page
  likelyPosition: string   // first input, last button, nav item, etc
  attributeHints: string[] // what attributes/traits to look for in DOM
  pageContext: string       // login | dashboard | form | settings | etc
}

const SYSTEM_PROMPT = `
You are a senior QA architect. Your job is to deeply understand what a 
tester is describing and produce a precise search intent that a DOM 
specialist can use to find the right element.

You NEVER look at the DOM. You reason purely from:
1. The plain English description of the element
2. The page name and all other targets on the same page (for context)

## How to reason

Step 1 — Infer the page type from ALL targets together:
Look at the full list of targets on this page, not just one in isolation.
- Targets like "email field", "password field", "submit button" = login page
- Targets like "item name", "amount", "description", "tax field" = create/edit form  
- Targets like "inventory dropdown", "create item option" = dashboard with navigation
- Use this page-level understanding when analyzing each individual target

Step 2 — Understand each target precisely:
- ELEMENT TYPE: input / button / link / dropdown / tab / checkbox / select / nav item
- PURPOSE: what does this element DO on this specific page type?
- POSITION: where is it likely placed? (first input, second input, primary CTA, sidebar nav)
- ATTRIBUTE HINTS: what HTML attributes would give it away?
  Examples: type=email, type=password, type=submit, placeholder~=email,
  role=button, aria-label~=submit, data-testid, text content, class patterns

Step 3 — Handle ambiguous targets intelligently:
- "store name / email field" on login = first input, accepts username or email identifier
- "submit button" = primary form action, likely type=submit or large prominent button
- "inventory dropdown on navbar" = nav element that triggers a dropdown, in the top navbar
- "VEHICLE button" = button whose visible text is "VEHICLE", likely a tab or category picker
- "create item option from dropdown" = a menu item inside an open dropdown

## Output format

Return ONLY a JSON array, no markdown, no explanation.
[
  {
    "target": "exact original description as given",
    "elementType": "input",
    "purpose": "accepts the store name or email as a login identifier",
    "likelyPosition": "first input field in the login form",
    "attributeHints": ["type=text or type=email", "placeholder contains email, store, or username", "name=email or name=username"],
    "pageContext": "login"
  }
]
`.trim()

export class SupervisorAgent {
  constructor(private model: BaseChatModel) {}

  async analyzeTargets(targets: string[], pageName: string): Promise<SearchIntent[]> {
    console.log(`[SUPERVISOR] Analyzing ${targets.length} target(s) for page: "${pageName}"`)

    const response = await this.model.invoke([
      new SystemMessage(SYSTEM_PROMPT),
      new HumanMessage(
        `Page name: "${pageName}"\n\n` +
        `All targets on this page (use all of them together for context):\n` +
        targets.map((t, i) => `${i + 1}. ${t}`).join('\n') +
        `\n\nAnalyze each target and return the JSON array.`
      ),
    ])

    const text = (response.content as string).trim().replace(/```json|```/g, '').trim()

    try {
      const intents = JSON.parse(text) as SearchIntent[]
      for (const intent of intents) {
        console.log(`[SUPERVISOR]   "${intent.target}"`)
        console.log(`[SUPERVISOR]     type=${intent.elementType} | ${intent.purpose}`)
        console.log(`[SUPERVISOR]     position: ${intent.likelyPosition}`)
        console.log(`[SUPERVISOR]     hints: [${intent.attributeHints.join(', ')}]`)
      }
      return intents
    } catch {
      throw new Error(`Supervisor failed to parse: ${text}`)
    }
  }
}