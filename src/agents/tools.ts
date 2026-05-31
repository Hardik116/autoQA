import type { BrowserSession } from '../browser.js'
import type { MemoryStore } from '../memory.js'

// Every tool the master agent can call
// Each tool returns a string result the agent reads and reasons about

export interface ToolResult {
  success: boolean
  output: string
}

export class AgentTools {
  constructor(
    private browser: BrowserSession,
    private memory: MemoryStore,
    private baseUrl: string,
  ) {}

  // ── browser tools ──────────────────────────────────────────────────────────

  async navigate(urlPath: string): Promise<ToolResult> {
    try {
      await this.browser.navigate(this.baseUrl + urlPath)
      return { success: true, output: `Navigated to ${urlPath}` }
    } catch (err) {
      return { success: false, output: `Navigation failed: ${(err as Error).message}` }
    }
  }

  async get_dom(): Promise<ToolResult> {
    try {
      const dom = await this.browser.getDOM()
      return { success: true, output: dom }
    } catch (err) {
      return { success: false, output: `DOM fetch failed: ${(err as Error).message}` }
    }
  }

  async click(selector: string): Promise<ToolResult> {
    try {
      await this.browser.click(selector)
      return { success: true, output: `Clicked "${selector}"` }
    } catch (err) {
      return { success: false, output: `Click failed on "${selector}": ${(err as Error).message}` }
    }
  }

  async fill(selector: string, value: string): Promise<ToolResult> {
    try {
      await this.browser.fill(selector, value)
      return { success: true, output: `Filled "${selector}" with "${value}"` }
    } catch (err) {
      return { success: false, output: `Fill failed on "${selector}": ${(err as Error).message}` }
    }
  }

  async select(selector: string, value: string): Promise<ToolResult> {
    try {
      await this.browser.select(selector, value)
      return { success: true, output: `Selected "${value}" in "${selector}"` }
    } catch (err) {
      return { success: false, output: `Select failed: ${(err as Error).message}` }
    }
  }

  async wait_seconds(seconds: number): Promise<ToolResult> {
    await new Promise(r => setTimeout(r, seconds * 1000))
    return { success: true, output: `Waited ${seconds}s` }
  }

  async wait_for_network(): Promise<ToolResult> {
    try {
      await this.browser.waitFor('networkidle')
      return { success: true, output: 'Network is idle' }
    } catch (err) {
      return { success: false, output: `Wait failed: ${(err as Error).message}` }
    }
  }

  async screenshot(label: string): Promise<ToolResult> {
    try {
      const filePath = `.promptest/screenshots/${label}-${Date.now()}.png`
      await this.browser.screenshot(filePath)
      return { success: true, output: `Screenshot saved: ${filePath}` }
    } catch (err) {
      return { success: false, output: `Screenshot failed: ${(err as Error).message}` }
    }
  }

  async get_url(): Promise<ToolResult> {
    try {
      const url = await this.browser.getCurrentUrl()
      return { success: true, output: url }
    } catch (err) {
      return { success: false, output: `Could not get URL: ${(err as Error).message}` }
    }
  }

  // ── memory tools ───────────────────────────────────────────────────────────

  check_memory(target: string, pageName: string): ToolResult {
    const entry = this.memory.check(target, pageName)
    if (!entry) return { success: false, output: `No memory for "${target}" on "${pageName}"` }
    return {
      success: true,
      output: JSON.stringify({
        selector:   entry.selector,
        confidence: entry.confidence,
        sourceFile: entry.sourceFile,
      }),
    }
  }

  save_memory(
    target: string,
    pageName: string,
    selector: string,
    confidence: 'source' | 'runtime',
    sourceFile?: string
  ): ToolResult {
    this.memory.save_selector(target, pageName, selector, confidence, sourceFile)
    return { success: true, output: `Saved to memory: "${target}" → "${selector}"` }
  }

  mark_memory_failed(target: string, pageName: string): ToolResult {
    this.memory.mark_failed(target, pageName)
    return { success: true, output: `Marked as failed in memory: "${target}"` }
  }

  // ── codebase tools ─────────────────────────────────────────────────────────

  async read_source_file(filePath: string): Promise<ToolResult> {
    try {
      const { readFile } = await import('fs/promises')
      const { existsSync } = await import('fs')
      if (!existsSync(filePath)) {
        return { success: false, output: `File not found: ${filePath}` }
      }
      const content = await readFile(filePath, 'utf-8')
      // Return only first 3000 chars to keep token count low
      return { success: true, output: content.slice(0, 3000) }
    } catch (err) {
      return { success: false, output: `Read failed: ${(err as Error).message}` }
    }
  }

  async find_source_file(pageName: string, srcDir: string): Promise<ToolResult> {
    try {
      const { glob } = await import('glob')

      // Search for files whose name matches the page
      const slug = pageName.toLowerCase().replace(/[^a-z0-9]/g, '*')
      const patterns = [
        `**/*${slug}*.component.html`,
        `**/*${slug}*.html`,
        `**/*${slug}*.tsx`,
        `**/*${slug}*.jsx`,
        `**/*${slug}*.vue`,
        `**/*${slug}*.svelte`,
      ]

      const found: string[] = []
      for (const p of patterns) {
        const matches = await glob(p, {
          cwd: srcDir,
          ignore: ['**/node_modules/**', '**/dist/**'],
          absolute: true,
        })
        found.push(...matches)
      }

      if (!found.length) return { success: false, output: `No source file found for "${pageName}"` }
      return { success: true, output: found.join('\n') }
    } catch (err) {
      return { success: false, output: `Search failed: ${(err as Error).message}` }
    }
  }
}