import { readFile } from 'fs/promises'
import { glob } from 'glob'
import type { PromptFile, PageBlock, Step, Action } from './types.js'

// Parses the .prompt text format:
//
//   name: Test name
//   baseUrl: http://localhost:3000   (optional)
//   tags: auth, smoke                (optional)
//
//   --- page label ---
//   navigate: /login
//   fill: email field >> test@example.com
//   click: submit button
//   waitForSec: 2
//   verify: welcome message should be visible
//
//   --- next page label ---
//   click: settings link
//   verify: settings page should be open

export async function parsePromptFile(filePath: string): Promise<PromptFile> {
  const raw = await readFile(filePath, 'utf-8')
  const lines = raw.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))

  let name = ''
  let baseUrl: string | undefined
  let tags: string[] | undefined
  const pages: PageBlock[] = []
  let currentPage: PageBlock | null = null

  for (const line of lines) {
    // --- page label ---
    if (line.startsWith('---') && line.endsWith('---')) {
      if (currentPage) pages.push(currentPage)
      const pageName = line.replace(/^---+\s*/, '').replace(/\s*---+$/, '').trim()
      currentPage = { name: pageName, steps: [], verify: [] }
      continue
    }

    // header fields (before first page block)
    if (!currentPage) {
      if (line.startsWith('name:'))    { name    = line.slice(5).trim(); continue }
      if (line.startsWith('baseUrl:')) { baseUrl = line.slice(8).trim(); continue }
      if (line.startsWith('tags:'))    { tags    = line.slice(5).split(',').map(t => t.trim()); continue }
      continue
    }

    // verify line
    if (line.startsWith('verify:')) {
      currentPage.verify.push(line.slice(7).trim())
      continue
    }

    // step lines
    const step = parseLine(line)
    if (step) currentPage.steps.push(step)
  }

  if (currentPage) pages.push(currentPage)

  if (!name)         throw new Error(`${filePath}: missing "name:" field`)
  if (!pages.length) throw new Error(`${filePath}: no page blocks found (add --- page name ---)`)

  return { name, baseUrl, tags, pages }
}

function parseLine(line: string): Step | null {
  // navigate: /path
  if (line.startsWith('navigate:')) {
    return { action: 'navigate', value: line.slice(9).trim() }
  }

  // fill: target >> value
  if (line.startsWith('fill:')) {
    const rest = line.slice(5).trim()
    const [target, value] = rest.split('>>').map(s => s.trim())
    return { action: 'fill', target, value: value ?? '' }
  }

  // click: target
  if (line.startsWith('click:')) {
    return { action: 'click', target: line.slice(6).trim() }
  }

  // select: target >> value
  if (line.startsWith('select:')) {
    const rest = line.slice(7).trim()
    const [target, value] = rest.split('>>').map(s => s.trim())
    return { action: 'select', target, value: value ?? '' }
  }

  // waitFor: condition description
  if (line.startsWith('waitFor:')) {
    return { action: 'waitFor', condition: line.slice(8).trim() }
  }

  // waitForSec: 2
  if (line.startsWith('waitForSec:')) {
    return { action: 'waitForSec', value: line.slice(11).trim() }
  }

  return null
}

export async function findPromptFiles(testDir: string, tags?: string[]): Promise<string[]> {
  console.log(`[DEBUG-PARSER] Finding prompt files in: ${testDir}`)
  const files = await glob(`${testDir}/**/*.prompt.yaml`, { posix: true })
  console.log(`[DEBUG-PARSER] Found ${files.length} raw prompt files`)
  files.forEach(f => console.log(`[DEBUG-PARSER]   Found: ${f}`))

  if (!tags?.length) {
    console.log(`[DEBUG-PARSER] No tag filter, returning all ${files.length} files`)
    return files
  }

  const filtered: string[] = []
  console.log(`[DEBUG-PARSER] Filtering by tags: ${tags.join(', ')}`)
  for (const file of files) {
    try {
      const p = await parsePromptFile(file)
      if (tags.some(t => p.tags?.includes(t))) {
        console.log(`[DEBUG-PARSER]   ✓ ${file} matches tags`)
        filtered.push(file)
      } else {
        console.log(`[DEBUG-PARSER]   ✗ ${file} doesn't match tags (has: ${p.tags?.join(', ') || 'none'})`)
      }
    } catch (err) {
      console.log(`[DEBUG-PARSER]   ✗ ${file} - error parsing: ${(err as Error).message}`)
    }
  }
  console.log(`[DEBUG-PARSER] Filtered to ${filtered.length} files after tag filter`)
  return filtered
}