import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'

const MEMORY_DIR  = '.promptest'
const MEMORY_FILE = '.promptest/memory.json'

export type ConfidenceLevel = 'source' | 'runtime'

export interface SelectorMemory {
  selector: string
  sourceFile?: string
  confidence: ConfidenceLevel
  lastWorked: string
  failCount: number
}

export interface Memory {
  version: number
  selectors: Record<string, SelectorMemory>  // key = "target | /page-url"
}

const EMPTY_MEMORY: Memory = { version: 1, selectors: {} }

export class MemoryStore {
  private memory: Memory = EMPTY_MEMORY
  private dirty = false

  async load(): Promise<void> {
    try {
      if (!existsSync(MEMORY_FILE)) {
        this.memory = { ...EMPTY_MEMORY, selectors: {} }
        return
      }
      const raw = await readFile(MEMORY_FILE, 'utf-8')
      this.memory = JSON.parse(raw) as Memory
      console.log(`[MEMORY] Loaded ${Object.keys(this.memory.selectors).length} cached selectors`)
    } catch {
      this.memory = { ...EMPTY_MEMORY, selectors: {} }
    }
  }

  async save(): Promise<void> {
    if (!this.dirty) return
    await mkdir(MEMORY_DIR, { recursive: true })
    await writeFile(MEMORY_FILE, JSON.stringify(this.memory, null, 2), 'utf-8')
    this.dirty = false
  }

  private key(target: string, pageName: string): string {
    return `${target.toLowerCase().trim()} | ${pageName.toLowerCase().trim()}`
  }

  // Normalize a string for fuzzy comparison — lowercase, remove punctuation, collapse spaces
  private normalize(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
  }

  // Score how similar two strings are — simple word overlap ratio
  private similarity(a: string, b: string): number {
    const wordsA = new Set(this.normalize(a).split(' ').filter(w => w.length > 2))
    const wordsB = new Set(this.normalize(b).split(' ').filter(w => w.length > 2))
    if (!wordsA.size || !wordsB.size) return 0
    let overlap = 0
    for (const w of wordsA) if (wordsB.has(w)) overlap++
    return overlap / Math.max(wordsA.size, wordsB.size)
  }

  check(target: string, pageName: string): SelectorMemory | null {
    // 1. Exact match first
    const exact = this.memory.selectors[this.key(target, pageName)]
    if (exact && exact.failCount < 3) return exact

    // 2. Fuzzy match — find best scoring entry above threshold
    const normalTarget = this.normalize(target)
    const normalPage   = this.normalize(pageName)

    let bestEntry: SelectorMemory | null = null
    let bestScore = 0

    for (const [key, entry] of Object.entries(this.memory.selectors)) {
      if (entry.failCount >= 3) continue
      const [keyTarget, keyPage] = key.split(' | ')
      if (!keyTarget || !keyPage) continue

      const targetScore = this.similarity(normalTarget, keyTarget)
      const pageScore   = this.similarity(normalPage, keyPage)

      // Both target AND page must be similar enough
      const combined = (targetScore * 0.7) + (pageScore * 0.3)
      if (combined > bestScore && targetScore >= 0.4 && combined >= 0.45) {
        bestScore = combined
        bestEntry = entry
        console.log(`[MEMORY] Fuzzy match: "${target}" ≈ "${keyTarget}" (score: ${combined.toFixed(2)})`)
      }
    }

    return bestEntry
  }

  save_selector(
    target: string,
    pageName: string,
    selector: string,
    confidence: ConfidenceLevel,
    sourceFile?: string
  ): void {
    const k = this.key(target, pageName)
    this.memory.selectors[k] = {
      selector,
      sourceFile,
      confidence,
      lastWorked: new Date().toISOString(),
      failCount: 0,
    }
    this.dirty = true
    console.log(`[MEMORY] Saved "${target}" → "${selector}" (${confidence})`)
  }

  mark_failed(target: string, pageName: string): void {
    const k = this.key(target, pageName)
    if (this.memory.selectors[k]) {
      this.memory.selectors[k].failCount++
      this.dirty = true
      console.log(`[MEMORY] Marked failed: "${target}" (fails: ${this.memory.selectors[k].failCount})`)
    }
  }

  // Used by init-memory to bulk insert from crawl
  bulk_insert(entries: Array<{
    target: string
    pageName: string
    selector: string
    sourceFile: string
  }>): void {
    for (const e of entries) {
      const k = this.key(e.target, e.pageName)
      // Don't overwrite entries that already have runtime confidence + no failures
      const existing = this.memory.selectors[k]
      if (existing && existing.failCount === 0) continue
      this.memory.selectors[k] = {
        selector:   e.selector,
        sourceFile: e.sourceFile,
        confidence: 'source',
        lastWorked: new Date().toISOString(),
        failCount:  0,
      }
    }
    this.dirty = true
  }

  stats(): { total: number; source: number; runtime: number } {
    const all    = Object.values(this.memory.selectors)
    const source  = all.filter(e => e.confidence === 'source').length
    return { total: all.length, source, runtime: all.length - source }
  }
}