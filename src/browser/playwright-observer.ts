import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import type { Observation } from "./observation.js";

export class PlaywrightObserver {
  private browser?: Browser;
  private page?: Page;
  private consoleErrors: string[] = [];
  private failedRequests: string[] = [];

  static async connect(cdpUrl: string): Promise<PlaywrightObserver> {
    const observer = new PlaywrightObserver();
    observer.browser = await chromium.connectOverCDP(cdpUrl);
    const context = observer.browser.contexts()[0] ?? (await observer.browser.newContext());
    observer.page = context.pages()[0] ?? (await context.newPage());
    observer.attach(observer.page);
    return observer;
  }

  async currentPage(): Promise<Page> {
    if (!this.browser) throw new Error("Playwright observer is not connected");
    const context = this.browser.contexts()[0] ?? (await this.browser.newContext());
    this.page = context.pages().at(-1) ?? this.page ?? (await context.newPage());
    this.attach(this.page);
    return this.page;
  }

  async observe(stepDir: string, stepIndex: number): Promise<Observation> {
    const page = await this.currentPage();
    await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => undefined);

    const screenshotPath = path.join(stepDir, `step-${String(stepIndex).padStart(3, "0")}.png`);
    fs.mkdirSync(stepDir, { recursive: true });
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);

    const visibleText = await page
      .evaluate(() => document.body?.innerText?.slice(0, 12000) ?? "")
      .catch(() => "");

    return {
      url: page.url(),
      title: await page.title().catch(() => ""),
      visibleText,
      screenshotPath: fs.existsSync(screenshotPath) ? screenshotPath : undefined,
      consoleErrors: [...this.consoleErrors],
      failedRequests: [...this.failedRequests],
      timestamp: new Date().toISOString()
    };
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => undefined);
  }

  private attach(page: Page): void {
    if ((page as unknown as { __agenticAttached?: boolean }).__agenticAttached) return;
    (page as unknown as { __agenticAttached?: boolean }).__agenticAttached = true;

    page.on("console", (msg) => {
      if (msg.type() === "error") {
        this.consoleErrors.push(`${new Date().toISOString()} ${msg.text()}`);
      }
    });

    page.on("requestfailed", (req) => {
      this.failedRequests.push(`${req.method()} ${req.url()} ${req.failure()?.errorText ?? ""}`.trim());
    });
  }
}
