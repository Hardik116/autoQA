import { readFile } from 'fs/promises'
import { existsSync } from 'fs'
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

// Load .env file manually — no extra package needed
async function loadEnv(): Promise<void> {
  if (!existsSync('.env')) return
  const raw = await readFile('.env', 'utf-8')
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const [key, ...rest] = trimmed.split('=')
    if (key && rest.length) {
      process.env[key.trim()] = rest.join('=').trim().replace(/^["']|["']$/g, '')
    }
  }
}

// Replace ${VAR_NAME} with actual env values
function interpolateEnv(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, name) => {
    return process.env[name.trim()] ?? ''
  })
}

// Walk config object and interpolate all string values
function interpolateConfig(obj: Record<string, unknown>): void {
  for (const key of Object.keys(obj)) {
    const val = obj[key]
    if (typeof val === 'string') {
      obj[key] = interpolateEnv(val)
    } else if (val && typeof val === 'object') {
      interpolateConfig(val as Record<string, unknown>)
    }
  }
}

export async function loadConfig(configPath = 'promptest.config.yaml'): Promise<Config> {
  await loadEnv()

  try {
    const raw = await readFile(configPath, 'utf-8')
    const parsed = yaml.load(raw) as Record<string, unknown>
    interpolateConfig(parsed)
    return { ...DEFAULTS, ...(parsed as Partial<Config>) }
  } catch {
    return { ...DEFAULTS }
  }
}