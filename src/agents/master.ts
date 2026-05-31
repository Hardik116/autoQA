import { HumanMessage, SystemMessage, AIMessage } from '@langchain/core/messages'
import { ChatOpenAI } from '@langchain/openai'
import { ChatOllama } from '@langchain/ollama'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { AgentTools } from './tools.js'
import type { Config, Step } from '../types.js'

const MAX_ITERATIONS = 12

const TOOL_LIST = `
EXACT TOOL NAMES — copy exactly, never invent names:
  navigate           { "path": "/login" }
  get_dom            {}
  get_url            {}
  click              { "selector": "css-selector" }
  fill               { "selector": "css-selector", "value": "text" }
  select             { "selector": "css-selector", "value": "option" }
  wait_seconds       { "seconds": 2 }
  wait_for_network   {}
  screenshot         { "label": "name" }
  check_memory       { "target": "description", "page": "page name" }
  save_memory        { "target": "description", "page": "page name", "selector": "css", "confidence": "runtime" }
  mark_memory_failed { "target": "description", "page": "page name" }
  find_source_file   { "pageName": "login", "srcDir": "path/to/src" }
  read_source_file   { "filePath": "full/path/to/file.html" }
`.trim()

const SYSTEM_PROMPT = `
You are a browser automation agent. You execute test steps by calling tools.

RULES:
- You MUST always respond with a JSON object — never plain text
- NEVER apologize or explain — only output JSON
- Use ONLY the exact tool names listed below

${TOOL_LIST}

DECISION ORDER for click/fill/select:
1. check_memory first (fastest)
2. find_source_file → read_source_file (if memory miss)
3. get_dom (if source not useful)
4. Try selector → if works → save_memory → done

RESPONSE FORMAT when calling a tool:
{"reasoning":"why","tool":"tool_name","args":{},"done":false}

RESPONSE FORMAT when step is complete:
{"reasoning":"what happened","tool":null,"args":{},"done":true,"result":"success","message":"summary"}

RESPONSE FORMAT when step fails:
{"reasoning":"why","tool":null,"args":{},"done":true,"result":"failure","message":"what went wrong"}
`.trim()

interface AgentResponse {
  reasoning: string
  tool: string | null
  args: Record<string, unknown>
  done: boolean
  result?: 'success' | 'failure'
  message?: string
}

function createJsonModel(config: Config): BaseChatModel {
  if (config.provider === 'ollama') {
    return new ChatOllama({
      model: config.model,
      baseUrl: config.ollamaUrl ?? 'http://localhost:11434',
      format: 'json',  // Ollama native JSON mode
    })
  }

  // OpenRouter — enable JSON mode via response_format
  // Works with Gemini 2.0 Flash Lite and most modern models
  return new ChatOpenAI({
    modelName: config.model,
    openAIApiKey: config.apiKey ?? process.env.OPENROUTER_API_KEY ?? '',
    modelKwargs: {
      response_format: { type: 'json_object' },  // ← forces valid JSON every time
    },
    configuration: {
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        'HTTP-Referer': 'https://github.com/promptest/promptest',
        'X-Title': 'promptest',
      },
    },
  })
}

function tryParseJSON(text: string): AgentResponse | null {
  try { return JSON.parse(text.trim()) as AgentResponse } catch { /* */ }
  const s = text.indexOf('{'), e = text.lastIndexOf('}')
  if (s !== -1 && e > s) {
    try { return JSON.parse(text.slice(s, e + 1)) as AgentResponse } catch { /* */ }
  }
  return null
}

export class MasterAgent {
  private model: BaseChatModel

  constructor(
    private config: Config,
    private tools: AgentTools,
    private srcDir: string,
  ) {
    this.model = createJsonModel(config)
  }

  async executeStep(step: Step, pageName: string): Promise<{ success: boolean; message: string }> {
    const stepDesc = this.describeStep(step)
    console.log(`\n[MASTER] Executing: ${stepDesc}`)

    const history = [
      new SystemMessage(SYSTEM_PROMPT),
      new HumanMessage(
        `Page: "${pageName}" | srcDir: ${this.srcDir}\n` +
        `Step: ${stepDesc}\n\n` +
        `Start with check_memory. Respond with JSON only.`
      ),
    ]

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const response = await this.model.invoke(history)
      const raw    = (response.content as string)
      const parsed = tryParseJSON(raw)

      if (!parsed) {
        console.log(`[MASTER] Bad JSON: ${raw.slice(0, 80).replace(/\n/g, ' ')}`)
        history.push(new AIMessage(raw))
        history.push(new HumanMessage(
          `Invalid JSON. Respond ONLY with a JSON object.\n` +
          `Example: {"reasoning":"checking memory","tool":"check_memory","args":{"target":"${step.target ?? ''}","page":"${pageName}"},"done":false}`
        ))
        continue
      }

      console.log(`[MASTER] Reasoning: ${parsed.reasoning}`)

      if (parsed.done) {
        console.log(`[MASTER] Step ${parsed.result}: ${parsed.message}`)
        return { success: parsed.result === 'success', message: parsed.message ?? '' }
      }

      if (!parsed.tool) {
        history.push(new AIMessage(raw))
        history.push(new HumanMessage('Specify a tool or mark done:true.'))
        continue
      }

      const toolResult = await this.callTool(parsed.tool, parsed.args)
      console.log(`[MASTER] "${parsed.tool}" → ${toolResult.success ? 'OK' : 'FAIL'}: ${toolResult.output.slice(0, 120)}`)

      history.push(new AIMessage(raw))
      history.push(new HumanMessage(
        `Tool "${parsed.tool}" result:\nsuccess:${toolResult.success}\noutput:${toolResult.output}\n\nContinue. JSON only.`
      ))
    }

    return { success: false, message: `Did not complete within ${MAX_ITERATIONS} iterations` }
  }

  async evaluateAssertion(assertion: string, pageName: string): Promise<{ passed: boolean; reason: string }> {
    console.log(`[MASTER] Evaluating: "${assertion}"`)
    const dom = await this.tools.get_dom()
    const url = await this.tools.get_url()

    const response = await this.model.invoke([
      new SystemMessage(
        'You are a QA engineer. Evaluate the assertion against the page DOM.\n' +
        'Respond with ONLY this JSON: {"passed":true,"reason":"explanation"}'
      ),
      new HumanMessage(`URL:${url.output}\nDOM:\n${dom.output}\n\nAssertion:"${assertion}"\n\nJSON:`),
    ])

    const parsed = tryParseJSON(response.content as string) as unknown as { passed: boolean; reason: string } | null
    if (parsed) {
      console.log(`[MASTER] ${parsed.passed ? '✓' : '✗'} ${parsed.reason}`)
      return parsed
    }
    return { passed: false, reason: 'Could not parse assertion result' }
  }

  private describeStep(step: Step): string {
    switch (step.action) {
      case 'navigate':   return `navigate to ${step.value}`
      case 'click':      return `click: "${step.target}"`
      case 'fill':       return `fill: "${step.target}" with "${step.value}"`
      case 'select':     return `select: "${step.value}" in "${step.target}"`
      case 'waitFor':    return `wait for: ${step.condition}`
      case 'waitForSec': return `wait ${step.value} seconds`
      default:           return JSON.stringify(step)
    }
  }

  private async callTool(tool: string, args: Record<string, unknown>): Promise<{ success: boolean; output: string }> {
    const VALID = 'Valid tools: navigate,get_dom,get_url,click,fill,select,wait_seconds,wait_for_network,screenshot,check_memory,save_memory,mark_memory_failed,find_source_file,read_source_file'
    switch (tool) {
      case 'navigate':           return this.tools.navigate(args.path as string)
      case 'get_dom':            return this.tools.get_dom()
      case 'get_url':            return this.tools.get_url()
      case 'click':              return this.tools.click(args.selector as string)
      case 'fill':               return this.tools.fill(args.selector as string, args.value as string)
      case 'select':             return this.tools.select(args.selector as string, args.value as string)
      case 'wait_seconds':       return this.tools.wait_seconds(Number(args.seconds ?? 1))
      case 'wait_for_network':   return this.tools.wait_for_network()
      case 'screenshot':         return this.tools.screenshot((args.label as string) ?? 'debug')
      case 'check_memory':       return this.tools.check_memory(args.target as string, args.page as string)
      case 'save_memory':        return this.tools.save_memory(args.target as string, args.page as string, args.selector as string, args.confidence as 'source' | 'runtime', args.sourceFile as string | undefined)
      case 'mark_memory_failed': return this.tools.mark_memory_failed(args.target as string, args.page as string)
      case 'find_source_file':   return this.tools.find_source_file(args.pageName as string, (args.srcDir as string) ?? this.srcDir)
      case 'read_source_file':   return this.tools.read_source_file(args.filePath as string)
      default:                   return { success: false, output: `Unknown tool: "${tool}". ${VALID}` }
    }
  }
}