import fs from "node:fs";
import path from "node:path";
import { CdpBrowserClient } from "./cdp-client.js";
import { collectAriaTree } from "./aria-tree.js";
import type { Observation } from "./observation.js";

export class CdpObserver {
  private client?: CdpBrowserClient;

  static async connect(cdpUrl: string): Promise<CdpObserver> {
    const observer = new CdpObserver();
    observer.client = new CdpBrowserClient({ cdpUrl });
    await observer.client.connect();
    await observer.client.ensurePage();
    return observer;
  }

  async observe(stepDir: string, stepIndex: number): Promise<Observation> {
    const client = this.requireClient();
    await client.ensurePage();
    await client.waitForReadyState(5_000, "interactive").catch(() => undefined);

    const screenshotPath = path.join(stepDir, `step-${String(stepIndex).padStart(3, "0")}.png`);
    fs.mkdirSync(stepDir, { recursive: true });
    await client.captureScreenshot(screenshotPath).catch(() => false);

    const pageData = await client
      .evaluate<{ url: string; title: string; visibleText: string }>(`(() => ({
        url: location.href,
        title: document.title,
        visibleText: (document.body?.innerText ?? "").slice(0, 12000)
      }))()`)
      .catch(() => ({ url: "", title: "", visibleText: "" }));
    const page = await client.activePage();
    const aria = await collectAriaTree(page).catch(() => ({
      ariaTree: "",
      ariaNodes: []
    }));

    return {
      url: pageData.url,
      title: pageData.title,
      visibleText: pageData.visibleText,
      ariaTree: aria.ariaTree,
      ariaNodes: aria.ariaNodes,
      screenshotPath: fs.existsSync(screenshotPath) ? screenshotPath : undefined,
      consoleErrors: [...client.consoleErrors],
      failedRequests: [...client.failedRequests],
      timestamp: new Date().toISOString()
    };
  }

  async close(): Promise<void> {
    await this.client?.close().catch(() => undefined);
  }

  private requireClient(): CdpBrowserClient {
    if (!this.client) throw new Error("CDP observer is not connected");
    return this.client;
  }
}
