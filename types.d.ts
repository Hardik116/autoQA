export type Provider = 'openrouter' | 'ollama';
export type Action = 'navigate' | 'click' | 'fill' | 'select' | 'waitFor';
export interface Step {
    action: Action;
    target?: string;
    to?: string;
    value?: string;
    condition?: string;
}
export interface PromptFile {
    name: string;
    baseUrl?: string;
    tags?: string[];
    steps: Step[];
    verify: string[];
}
export interface AssertionResult {
    assertion: string;
    passed: boolean;
    reason: string;
}
export interface TestResult {
    file: string;
    name: string;
    passed: boolean;
    durationMs: number;
    assertions: AssertionResult[];
    screenshotPath?: string;
    error?: string;
}
export interface Config {
    provider: Provider;
    model: string;
    apiKey?: string;
    ollamaUrl?: string;
    baseUrl: string;
    testDir: string;
    headless: boolean;
    retries: number;
}
//# sourceMappingURL=types.d.ts.map