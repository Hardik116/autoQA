import { readFile } from 'fs/promises'
import yaml from 'js-yaml'
import type { Config } from './types.js'

const DEFAULTS: Config = {
  provider: 'openrouter',
  model: 'anthropic/claude-3-haiku',
  baseUrl: 'http://localhost:3000',
  srcDir: './src',
  testDir: './tests',
  headless: true,
  retries: 1,
}

export async function loadConfig(configPath = 'promptest.config.yaml'): Promise<Config> {
  try {
    const raw = await readFile(configPath, 'utf-8')
    const parsed = yaml.load(raw) as Partial<Config>
    return { ...DEFAULTS, ...parsed }
  } catch {
    return { ...DEFAULTS }
  }
}