import type { TestResult } from './types.js'

const c = {
  green:  (s: string) => `\x1b[32m${s}\x1b[0m`,
  red:    (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim:    (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold:   (s: string) => `\x1b[1m${s}\x1b[0m`,
}

export function printResults(results: TestResult[]): void {
  console.log()

  for (const r of results) {
    const icon     = r.passed ? c.green('✓') : c.red('✗')
    const duration = c.dim(`(${(r.durationMs / 1000).toFixed(1)}s)`)
    console.log(`  ${icon}  ${r.name} ${duration}`)

    if (!r.passed) {
      if (r.error) {
        console.log(`     ${c.red('└')} Error: ${r.error}`)
      }

      for (const page of r.pageResults.filter(p => !p.passed)) {
        console.log(`     ${c.dim(`└ page: "${page.pageName}"`) }`)
        for (const a of page.assertions.filter(a => !a.passed)) {
          console.log(`       ${c.red('✗')} "${a.assertion}"`)
          console.log(`         ${c.dim(a.reason)}`)
        }
        if (page.screenshotPath) {
          console.log(`         ${c.yellow('screenshot:')} ${page.screenshotPath}`)
        }
      }
    }
  }

  const total  = results.length
  const passed = results.filter(r => r.passed).length
  const failed = total - passed

  console.log()
  console.log(
    `  ${c.bold(`${total} test${total !== 1 ? 's' : ''}`)}` +
    ` · ${c.green(`${passed} passed`)}` +
    ` · ${failed > 0 ? c.red(`${failed} failed`) : c.dim(`${failed} failed`)}`
  )
  console.log()
}