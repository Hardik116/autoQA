import { chromium } from 'playwright'
import { writeFile, mkdir } from 'fs/promises'
import path from 'path'
import { Agent } from './agent.js'
import type { Config } from './types.js'

interface CapturedAction {
  type: 'navigate' | 'click' | 'fill' | 'select' | 'pageChange'
  url?: string
  value?: string
  element?: {
    tag: string
    id?: string
    name?: string
    type?: string
    placeholder?: string
    ariaLabel?: string
    text?: string
    role?: string
    dataTestId?: string
    className?: string
  }
}

interface PageGroup {
  url: string
  actions: CapturedAction[]
}

export async function record(outputPath: string, baseUrl: string, config: Config): Promise<void> {
  console.log('\n  promptest recorder')
  console.log('  ──────────────────────────────────────────')
  console.log(`  Opening : ${baseUrl}`)
  console.log(`  Output  : ${outputPath}`)
  console.log('  ──────────────────────────────────────────')
  console.log('  Interact with the app normally.')
  console.log('  Close the browser when done.\n')

  const browser = await chromium.launch({ headless: false })
  const context = await browser.newContext()
  const page    = await context.newPage()

  const capturedActions: CapturedAction[] = []
  let lastUrl = ''

  // ── inject listener script BEFORE first navigation ───────────────────────
  // addInitScript runs on every new page/frame load, so it's always active
  await context.addInitScript(() => {
    ;(window as any).__promptestActions = (window as any).__promptestActions || []

    // Capture clicks
    document.addEventListener('click', (e) => {
      const el = e.target as HTMLElement
      if (!el?.tagName) return
      ;(window as any).__promptestActions.push({
        type: 'click',
        tag: el.tagName.toLowerCase(),
        id: el.id || undefined,
        name: (el as HTMLInputElement).name || undefined,
        inputType: (el as HTMLInputElement).type || undefined,
        placeholder: (el as HTMLInputElement).placeholder || undefined,
        ariaLabel: el.getAttribute('aria-label') || undefined,
        role: el.getAttribute('role') || undefined,
        dataTestId: el.getAttribute('data-testid') || undefined,
        text: el.innerText?.trim().slice(0, 80) || undefined,
        className: el.className?.slice(0, 100) || undefined,
      })
    }, true)

    // Capture fills and selects — fires on blur with the final value
    document.addEventListener('change', (e) => {
      const el = e.target as HTMLInputElement
      if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(el?.tagName)) return
      ;(window as any).__promptestActions.push({
        type: el.tagName === 'SELECT' ? 'select' : 'fill',
        tag: el.tagName.toLowerCase(),
        id: el.id || undefined,
        name: el.name || undefined,
        inputType: el.type || undefined,
        placeholder: el.placeholder || undefined,
        ariaLabel: el.getAttribute('aria-label') || undefined,
        dataTestId: el.getAttribute('data-testid') || undefined,
        value: el.tagName === 'SELECT'
          ? (el as unknown as HTMLSelectElement).options[(el as unknown as HTMLSelectElement).selectedIndex]?.text
          : el.value,
      })
    }, true)
  })

  // ── track page navigations ────────────────────────────────────────────────
  page.on('framenavigated', frame => {
    if (frame !== page.mainFrame()) return
    const url = frame.url()
    if (url === lastUrl || url === 'about:blank') return
    lastUrl = url

    const relative = url.startsWith(baseUrl)
      ? url.slice(baseUrl.length) || '/'
      : url

    capturedActions.push({ type: 'navigate', url: relative })
    console.log(`  [nav]   ${relative}`)
  })

  // ── open the app automatically ────────────────────────────────────────────
  await page.goto(baseUrl)

  // ── poll for captured actions every 500ms ─────────────────────────────────
  const poll = setInterval(async () => {
    try {
      const actions = await page.evaluate(() => {
        const all = [...((window as any).__promptestActions || [])]
        ;(window as any).__promptestActions = []
        return all
      })

      for (const a of actions) {
        if (a.type === 'click') {
          capturedActions.push({ type: 'click', element: a })
          console.log(`  [click] ${describeElement(a)}`)

        } else if (a.type === 'fill') {
          // Replace previous fill on same element (capture final value only)
          const last = capturedActions[capturedActions.length - 1]
          if (last?.type === 'fill' && describeElement(last.element!) === describeElement(a)) {
            capturedActions.pop()
          }
          capturedActions.push({ type: 'fill', element: a, value: a.value })
          console.log(`  [fill]  ${describeElement(a)} = "${a.value}"`)

        } else if (a.type === 'select') {
          capturedActions.push({ type: 'select', element: a, value: a.value })
          console.log(`  [select] ${describeElement(a)} = "${a.value}"`)
        }
      }
    } catch {
      // page is navigating — ignore evaluation errors
    }
  }, 500)

  // ── wait until browser is closed ──────────────────────────────────────────
  await new Promise<void>(resolve => {
    browser.on('disconnected', () => resolve())
  })

  clearInterval(poll)
  console.log('\n  Browser closed. Generating .prompt file...\n')

  if (capturedActions.length === 0) {
    console.log('  No actions captured. Did the browser close too quickly?\n')
    return
  }

  const pageGroups = groupByPage(capturedActions)
  const agent = new Agent(config)
  const promptLines = await buildPromptFile(pageGroups, agent)

  const dir = path.dirname(outputPath)
  await mkdir(dir, { recursive: true })
  await writeFile(outputPath, promptLines.join('\n'), 'utf-8')

  console.log(`  ✓ Saved to: ${outputPath}`)
  console.log('  Open the file and add verify: lines where needed.\n')
}

// ── helpers ───────────────────────────────────────────────────────────────────

function describeElement(el: Record<string, string>): string {
  return el.ariaLabel || el.placeholder || el.text || el.dataTestId
    || el.id || el.name || `${el.tag}[type=${el.inputType}]` || el.tag || 'unknown'
}

function groupByPage(actions: CapturedAction[]): PageGroup[] {
  const groups: PageGroup[] = []
  let current: PageGroup | null = null

  for (const action of actions) {
    if (action.type === 'navigate') {
      if (current) groups.push(current)
      current = { url: action.url!, actions: [] }
    } else if (current) {
      current.actions.push(action)
    }
  }

  if (current) groups.push(current)
  return groups
}

async function buildPromptFile(groups: PageGroup[], agent: Agent): Promise<string[]> {
  const lines: string[] = ['name: Recorded flow', 'tags: recorded', '']

  for (const [idx, group] of groups.entries()) {
    const pageName = `page ${idx + 1} (${group.url})`
    lines.push(`--- ${pageName} ---`)
    lines.push(`navigate: ${group.url}`)

    // Batch-describe all raw element identifiers on this page in one AI call
    const rawDescriptions = group.actions
      .filter(a => a.element)
      .map(a => describeElement(a.element as Record<string, string>))

    let naturalDescriptions: Record<string, string> = {}
    if (rawDescriptions.length > 0) {
      naturalDescriptions = await agent.describeElements(rawDescriptions)
    }

    for (const action of group.actions) {
      if (!action.element) continue
      const raw     = describeElement(action.element as Record<string, string>)
      const natural = naturalDescriptions[raw] || raw

      if (action.type === 'click')       lines.push(`click: ${natural}`)
      else if (action.type === 'fill')   lines.push(`fill: ${natural} >> ${action.value}`)
      else if (action.type === 'select') lines.push(`select: ${natural} >> ${action.value}`)
    }

    lines.push(`# verify: add your assertions for this page here`)
    lines.push('')
  }

  return lines
}