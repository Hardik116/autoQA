#!/usr/bin/env node
import { Command } from 'commander'
import { writeFile, mkdir } from 'fs/promises'
import { loadConfig } from './config.js'
import { findPromptFiles } from './parser.js'
import { runTest } from './runner.js'
import { printResults } from './reporter.js'
import { initMemory } from './init-memory.js'

const program = new Command()

program
  .name('promptest')
  .description('AI-powered autonomous E2E testing')
  .version('0.2.0')

// ── run ───────────────────────────────────────────────────────────────────────
program
  .command('run')
  .description('Run all .prompt test files autonomously')
  .option('-d, --dir <path>',     'test directory')
  .option('-t, --tags <tags>',    'filter by tags (comma-separated)')
  .option('--headed',             'run browser in headed mode')
  .option('--base-url <url>',     'override baseUrl from config')
  .option('--src <path>',         'source code directory for codebase reading')
  .action(async (opts) => {
    const config = await loadConfig()
    if (opts.headed)   config.headless = false
    if (opts.dir)      config.testDir  = opts.dir
    if (opts.baseUrl)  config.baseUrl  = opts.baseUrl
    if (opts.src)      config.srcDir   = opts.src

    const tags = opts.tags?.split(',').map((t: string) => t.trim())

    console.log(`\n  promptest v0.2.0  ${config.provider} / ${config.model}`)
    console.log(`  memory: .promptest/memory.json\n`)

    const files = await findPromptFiles(config.testDir, tags)
    if (!files.length) {
      console.log(`  No .prompt files found in "${config.testDir}"\n`)
      process.exit(0)
    }

    const results = []
    for (const file of files) {
      const result = await runTest(file, config)
      results.push(result)
    }

    printResults(results)
    process.exit(results.some(r => !r.passed) ? 1 : 0)
  })

// ── init-memory ───────────────────────────────────────────────────────────────
program
  .command('init-memory')
  .description('Crawl your codebase and pre-populate selector memory')
  .option('--src <path>', 'source code directory to scan', './src')
  .action(async (opts) => {
    const config = await loadConfig()
    await initMemory(opts.src, config)
  })

// ── record ────────────────────────────────────────────────────────────────────
// program
//   .command('record')
//   .description('Record browser interactions and generate a .prompt file')
//   .option('-o, --output <path>', 'output file path', './tests/recorded.prompt')
//   .option('--base-url <url>',    'base URL to open',  'http://localhost:3000')
//   .action(async (opts) => {
//     const config = await loadConfig()
//     if (opts.baseUrl) config.baseUrl = opts.baseUrl
//     await record(opts.output, config.baseUrl, config)
//   })

// ── init ──────────────────────────────────────────────────────────────────────
program
  .command('init')
  .description('Scaffold config file and an example test')
  .action(async () => {
    await mkdir('tests', { recursive: true })

    await writeFile('promptest.config.yaml', [
      '# promptest configuration',
      '',
      'provider: openrouter',
      'model: anthropic/claude-3-haiku',
      'apiKey: YOUR_OPENROUTER_API_KEY',
      '',
      'baseUrl: http://localhost:3000',
      'srcDir: ./src          # path to your source code',
      'testDir: ./tests',
      'headless: true',
      'retries: 1',
    ].join('\n'), 'utf-8')

    await writeFile('tests/example.prompt', [
      'name: Example flow',
      'tags: smoke',
      '',
      '--- login page ---',
      'navigate: /login',
      'fill: email field >> test@example.com',
      'fill: password field >> secret123',
      'click: submit button',
      '# verify: add your assertions here',
    ].join('\n'), 'utf-8')

    console.log('\n  Created: promptest.config.yaml')
    console.log('  Created: tests/example.prompt')
    console.log('\n  Next steps:')
    console.log('    1. Set your API key in promptest.config.yaml')
    console.log('    2. Run: node dist/cli.js init-memory --src ./src')
    console.log('    3. Run: node dist/cli.js run\n')
  })

program.parse()