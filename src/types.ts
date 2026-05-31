export type Provider = 'openrouter' | 'ollama'

export type Action = 'navigate' | 'click' | 'fill' | 'select' | 'waitFor' | 'waitForSec'

export interface Step {
  action: Action
  target?: string
  value?: string
  condition?: string
}

export interface PageBlock {
  name: string
  steps: Step[]
  verify: string[]
}

export interface PromptFile {
  name: string
  baseUrl?: string
  tags?: string[]
  pages: PageBlock[]
}

export interface AssertionResult {
  assertion: string
  passed: boolean
  reason: string
}

export interface PageResult {
  pageName: string
  assertions: AssertionResult[]
  passed: boolean
  screenshotPath?: string
}

export interface TestResult {
  file: string
  name: string
  passed: boolean
  durationMs: number
  pageResults: PageResult[]
  error?: string
}

export interface Config {
  provider: Provider
  model: string
  apiKey?: string
  ollamaUrl?: string
  baseUrl: string
  testDir: string
  srcDir: string        // path to source code for codebase reading
  headless: boolean
  retries: number
}

export type PageSelectors = Record<string, string[]>