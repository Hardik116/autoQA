import { HumanMessage, SystemMessage, AIMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { AgentTools } from './tools.js'
import type { Step } from '../types.js'

const MAX_ITERATIONS = 10  // max loops per step before giving up

const SYSTEM_PROMPT = `
You are an autonomous browser test agent. You execute test steps by 
reasoning about the best approach, calling tools, and reflecting on results.

## Your tools

BROWSER:
- navigate(path)              — go to a URL path
- get_dom()                   — get the current page's interactive elements
- get_url()                   — get the current URL  
- click(selector)             — click an element by CSS selector
- fill(selector, value)       — type into an input field
- select(selector, value)     — choose a dropdown option
- wait_seconds(n)             — wait N seconds
- wait_for_network()          — wait for network activity to settle
- screenshot(label)           — take a screenshot for debugging

MEMORY (check this FIRST before anything else):
- check_memory(target, page)  — look up a cached selector that worked before
- save_memory(target, page, selector, confidence, sourceFile?) — save a working selector
- mark_memory_failed(target, page) — mark a cached selector as broken

CODEBASE:
- find_source_file(pageName, srcDir) — search for the HTML/template file for a page
- read_source_file(filePath)         — read a file's content to find selectors

## Your decision loop for each step

1. CHECK MEMORY first — if a working selector exists, try it immediately
2. If memory miss or selector fails → FIND SOURCE FILE and read the HTML
3. If source not found or selector not there → GET DOM from browser
4. Try the selector → if it works → SAVE TO MEMORY → done
5. If it fails → REFLECT on why → try a different selector → max ${MAX_ITERATIONS} attempts
6. If stuck → take a SCREENSHOT → report the failure clearly

## Rules
- Always check memory first — it's the fastest path
- Always save to memory when something works
- Mark memory as failed when a cached selector stops working
- Be specific about WHY something failed in your reasoning
- When a page changes after an action, the old DOM is stale — get a fresh one

## Response format

Each response must be a JSON object:
{
  "reasoning": "why you're taking this action",
  "tool": "tool_name",
  "args": { "arg1": "value1" },
  "done": false
}

When the step is fully complete:
{
  "reasoning": "the step succeeded because...",
  "tool": null,
  "args": {},
  "done": true,
  "result": "success | failure",
  "message": "what happened"
}
`.trim()

interface AgentResponse {
  reasoning: string
  tool: string | null
  args: Record<string, string | number>
  done: boolean
  result?: 'success' | 'failure'
  message?: string
}

export class MasterAgent {
  constructor(
    private model: BaseChatModel,
    private tools: AgentTools,
    private srcDir: string,
  ) {}

  async executeStep(step: Step, pageName: string): Promise<{ success: boolean; message: string }> {
    const stepDesc = this.describeStep(step)
    console.log(`\n[MASTER] Executing: ${stepDesc}`)

    const history = [
      new SystemMessage(SYSTEM_PROMPT),
      new HumanMessage(
        `Current page: "${pageName}"\n` +
        `Step to execute: ${stepDesc}\n` +
        `Source directory: ${this.srcDir}\n\n` +
        `Begin. Check memory first, then source, then DOM. Use at most ${MAX_ITERATIONS} tool calls.`
      ),
    ]

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const response = await this.model.invoke(history)
      const text = (response.content as string).trim().replace(/```json|```/g, '').trim()

      let parsed: AgentResponse
      try {
        parsed = JSON.parse(text) as AgentResponse
      } catch {
        console.log(`[MASTER] Bad JSON response, retrying... (${text.slice(0, 100)})`)
        history.push(new AIMessage(text))
        history.push(new HumanMessage('Your response was not valid JSON. Try again.'))
        continue
      }

      console.log(`[MASTER] Reasoning: ${parsed.reasoning}`)

      // Step complete
      if (parsed.done) {
        console.log(`[MASTER] Step ${parsed.result}: ${parsed.message}`)
        return {
          success: parsed.result === 'success',
          message: parsed.message ?? '',
        }
      }

      // Call the requested tool
      const toolResult = await this.callTool(parsed.tool!, parsed.args)
      console.log(`[MASTER] Tool "${parsed.tool}" → ${toolResult.success ? 'OK' : 'FAIL'}: ${toolResult.output.slice(0, 150)}`)

      // Add tool call + result to conversation history
      history.push(new AIMessage(text))
      history.push(new HumanMessage(
        `Tool "${parsed.tool}" result:\n` +
        `Success: ${toolResult.success}\n` +
        `Output: ${toolResult.output}\n\n` +
        `Continue. If the step is done mark done:true. If failed after multiple tries, mark done:true result:failure.`
      ))
    }

    return { success: false, message: `Step did not complete within ${MAX_ITERATIONS} iterations` }
  }

  async evaluateAssertion(assertion: string, pageName: string): Promise<{
    passed: boolean
    reason: string
  }> {
    console.log(`[MASTER] Evaluating: "${assertion}"`)

    const dom = await this.tools.get_dom()
    const url = await this.tools.get_url()

    const response = await this.model.invoke([
      new SystemMessage(
        'You are a QA engineer evaluating a single test assertion. ' +
        'Return ONLY a JSON object: {"passed": true/false, "reason": "explanation"}'
      ),
      new HumanMessage(
        `Current URL: ${url.output}\n` +
        `Page DOM:\n${dom.output}\n\n` +
        `Assertion: "${assertion}"\n\n` +
        `Return JSON only.`
      ),
    ])

    const text = (response.content as string).trim().replace(/```json|```/g, '').trim()
    try {
      const result = JSON.parse(text) as { passed: boolean; reason: string }
      const icon = result.passed ? '✓' : '✗'
      console.log(`[MASTER] ${icon} ${result.reason}`)
      return result
    } catch {
      return { passed: false, reason: `Could not parse assertion result: ${text}` }
    }
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private describeStep(step: Step): string {
    switch (step.action) {
      case 'navigate':    return `navigate to ${step.value}`
      case 'click':       return `click: "${step.target}"`
      case 'fill':        return `fill: "${step.target}" with "${step.value}"`
      case 'select':      return `select: "${step.value}" in "${step.target}"`
      case 'waitFor':     return `wait for: ${step.condition}`
      case 'waitForSec':  return `wait ${step.value} seconds`
      default:            return JSON.stringify(step)
    }
  }

  private async callTool(
    tool: string,
    args: Record<string, string | number>
  ): Promise<{ success: boolean; output: string }> {
    switch (tool) {
      // browser
      case 'navigate':          return this.tools.navigate(args.path as string)
      case 'get_dom':           return this.tools.get_dom()
      case 'get_url':           return this.tools.get_url()
      case 'click':             return this.tools.click(args.selector as string)
      case 'fill':              return this.tools.fill(args.selector as string, args.value as string)
      case 'select':            return this.tools.select(args.selector as string, args.value as string)
      case 'wait_seconds':      return this.tools.wait_seconds(args.seconds as number)
      case 'wait_for_network':  return this.tools.wait_for_network()
      case 'screenshot':        return this.tools.screenshot(args.label as string)

      // memory
      case 'check_memory':
        return this.tools.check_memory(args.target as string, args.page as string)
      case 'save_memory':
        return this.tools.save_memory(
          args.target as string, args.page as string,
          args.selector as string, args.confidence as 'source' | 'runtime',
          args.sourceFile as string | undefined
        )
      case 'mark_memory_failed':
        return this.tools.mark_memory_failed(args.target as string, args.page as string)

      // codebase
      case 'find_source_file':
        return this.tools.find_source_file(args.pageName as string, args.srcDir as string)
      case 'read_source_file':
        return this.tools.read_source_file(args.filePath as string)

      default:
        return { success: false, output: `Unknown tool: ${tool}` }
    }
  }
}