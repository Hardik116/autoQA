import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'

export class BrowserSession {
  private browser: Browser | null = null
  private page: Page | null = null

  async launch(headless: boolean): Promise<void> {
    console.log(`[DEBUG-BROWSER] Launching chromium (headless=${headless})...`)
    this.browser = await chromium.launch({ headless })
    console.log(`[DEBUG-BROWSER] Chromium launched, creating new page...`)
    this.page = await this.browser.newPage()
    console.log(`[DEBUG-BROWSER] Page created`)
  }

  async navigate(url: string): Promise<void> {
    console.log(`[DEBUG-BROWSER] Navigating to: ${url}`)
    await this.page!.goto(url, { waitUntil: 'domcontentloaded' })
    console.log(`[DEBUG-BROWSER] Navigation complete, current URL: ${this.page!.url()}`)
  }

  async click(selector: string): Promise<void> {
    console.log(`[DEBUG-BROWSER] Clicking selector: ${selector}`)
    await this.page!.locator(selector).first().click({ timeout: 10_000 })
    console.log(`[DEBUG-BROWSER] Click executed`)
  }

  // Try multiple selectors in order, use the first one that works
  async clickWithFallbacks(selectors: string[]): Promise<void> {
    console.log(`[DEBUG-BROWSER] Clicking with ${selectors.length} selector fallback(s): ${selectors.join(' | ')}`)
    let lastError: Error | null = null
    
    for (let i = 0; i < selectors.length; i++) {
      try {
        const selector = selectors[i]
        console.log(`[DEBUG-BROWSER]   Attempt ${i + 1}/${selectors.length}: "${selector}"`)
        await this.page!.locator(selector).first().click({ timeout: 5_000 })
        console.log(`[DEBUG-BROWSER]   ✓ Click succeeded on attempt ${i + 1}`)
        return
      } catch (err) {
        lastError = err as Error
        console.log(`[DEBUG-BROWSER]   ✗ Attempt ${i + 1} failed: ${lastError.message}`)
      }
    }
    
    throw new Error(`All ${selectors.length} selector(s) failed. Last error: ${lastError?.message}`)
  }

  async fill(selector: string, value: string): Promise<void> {
    console.log(`[DEBUG-BROWSER] Filling selector: ${selector} with value: ${value}`)
    await this.page!.locator(selector).first().fill(value, { timeout: 10_000 })
    console.log(`[DEBUG-BROWSER] Fill executed`)
  }

  // Try multiple selectors in order, use the first one that works
  async fillWithFallbacks(selectors: string[], value: string): Promise<void> {
    console.log(`[DEBUG-BROWSER] Filling with ${selectors.length} selector fallback(s): ${selectors.join(' | ')} = "${value}"`)
    let lastError: Error | null = null
    
    for (let i = 0; i < selectors.length; i++) {
      try {
        const selector = selectors[i]
        console.log(`[DEBUG-BROWSER]   Attempt ${i + 1}/${selectors.length}: "${selector}"`)
        await this.page!.locator(selector).first().fill(value, { timeout: 5_000 })
        console.log(`[DEBUG-BROWSER]   ✓ Fill succeeded on attempt ${i + 1}`)
        return
      } catch (err) {
        lastError = err as Error
        console.log(`[DEBUG-BROWSER]   ✗ Attempt ${i + 1} failed: ${lastError.message}`)
      }
    }
    
    throw new Error(`All ${selectors.length} selector(s) failed. Last error: ${lastError?.message}`)
  }

  async select(selector: string, value: string): Promise<void> {
    console.log(`[DEBUG-BROWSER] Selecting option "${value}" in selector: ${selector}`)
    await this.page!.locator(selector).first().selectOption(value, { timeout: 10_000 })
    console.log(`[DEBUG-BROWSER] Select executed`)
  }

  // Try multiple selectors in order, use the first one that works
  async selectWithFallbacks(selectors: string[], value: string): Promise<void> {
    console.log(`[DEBUG-BROWSER] Selecting with ${selectors.length} selector fallback(s): ${selectors.join(' | ')} = "${value}"`)
    let lastError: Error | null = null
    
    for (let i = 0; i < selectors.length; i++) {
      try {
        const selector = selectors[i]
        console.log(`[DEBUG-BROWSER]   Attempt ${i + 1}/${selectors.length}: "${selector}"`)
        await this.page!.locator(selector).first().selectOption(value, { timeout: 5_000 })
        console.log(`[DEBUG-BROWSER]   ✓ Select succeeded on attempt ${i + 1}`)
        return
      } catch (err) {
        lastError = err as Error
        console.log(`[DEBUG-BROWSER]   ✗ Attempt ${i + 1} failed: ${lastError.message}`)
      }
    }
    
    throw new Error(`All ${selectors.length} selector(s) failed. Last error: ${lastError?.message}`)
  }

  async waitFor(_condition: string): Promise<void> {
    console.log(`[DEBUG-BROWSER] Waiting for network idle state...`)
    await this.page!.waitForLoadState('networkidle', { timeout: 15_000 })
    console.log(`[DEBUG-BROWSER] Wait complete`)
  }

  // Returns a stripped-down DOM — only interactive + meaningful elements
  // Keeps token count low when sending to the AI
  async getDOM(): Promise<string> {
    console.log(`[DEBUG-BROWSER] Extracting DOM from page...`)
    const result = await this.page!.evaluate(() => {
      const SELECTOR = [
        'input', 'button', 'select', 'textarea', 'a',
        'h1', 'h2', 'h3', 'label',
        '[role="button"]', '[role="link"]', '[role="tab"]',
        '[aria-label]', '[placeholder]', '[data-testid]',
      ].join(',')

      return Array.from(document.querySelectorAll(SELECTOR))
        .map(el => {
          const attrs = Array.from(el.attributes)
            .filter(a => ['id', 'name', 'type', 'placeholder', 'aria-label',
                          'role', 'href', 'data-testid', 'class'].includes(a.name))
            .map(a => `${a.name}="${a.value}"`)
            .join(' ')

          const text = el.textContent?.trim().slice(0, 80) ?? ''
          return `<${el.tagName.toLowerCase()} ${attrs}>${text}</${el.tagName.toLowerCase()}>`
        })
        .join('\n')
    })
    console.log(`[DEBUG-BROWSER] DOM extracted (${result.split('\n').length} elements)`)
    return result
  }

  async getCurrentUrl(): Promise<string> {
    return this.page!.url()
  }

  async screenshot(path: string): Promise<void> {
    await this.page!.screenshot({ path, fullPage: false })
  }

  async close(): Promise<void> {
    console.log(`[DEBUG-BROWSER] Closing browser...`)
    await this.browser?.close()
    this.browser = null
    this.page = null
    console.log(`[DEBUG-BROWSER] Browser closed`)
  }
}