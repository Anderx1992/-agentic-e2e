import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from "@playwright/test";
import type { AgentAction } from "../agent/actions.js";

type BrowserHarnessOptions = {
  cdpUrl: string;
};

type PageInfo = {
  url: string;
  title: string;
  viewport: {
    width: number;
    height: number;
  };
  readyState: string;
};

type RuntimeRemoteObject = {
  type?: string;
  subtype?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
};

type RuntimeEvaluateResult = {
  result: RuntimeRemoteObject;
  exceptionDetails?: {
    text?: string;
    exception?: RuntimeRemoteObject;
  };
};

export class BrowserHarnessClient {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private client?: CDPSession;
  private clientPage?: Page;
  private connecting?: Promise<void>;

  constructor(private readonly options: BrowserHarnessOptions) {}

  async newTab(url: string): Promise<string> {
    const context = await this.ensureContext();
    const page = await context.newPage();
    await this.usePage(page);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await this.waitForLoad(10_000);
    return this.pageInfo();
  }

  async execute(action: AgentAction): Promise<string> {
    switch (action.type) {
      case "navigate":
        return this.newTab(action.url);
      case "click":
        await this.clickAt(action.x, action.y);
        await this.settleAfterInput();
        return this.pageInfo();
      case "type":
        await this.cdp("Input.insertText", { text: action.text });
        await this.settleAfterInput();
        return this.pageInfo();
      case "press":
        await this.pressKey(action.key);
        await this.settleAfterInput();
        return this.pageInfo();
      case "scroll":
        await this.cdp("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: 500,
          y: 500,
          deltaX: 0,
          deltaY: Math.round(action.deltaY),
          pointerType: "mouse"
        });
        await this.settleAfterInput();
        return this.pageInfo();
      case "wait":
        await this.sleep(Math.max(0, action.ms));
        await this.waitForLoad(5_000);
        return this.pageInfo();
      case "js":
        return this.evaluateJavaScript(action.code);
      case "done":
        return action.reason;
    }
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => undefined);
    this.browser = undefined;
    this.context = undefined;
    this.page = undefined;
    this.client = undefined;
    this.clientPage = undefined;
    this.connecting = undefined;
  }

  private async ensureContext(): Promise<BrowserContext> {
    if (!this.connecting) {
      this.connecting = this.connect();
    }
    await this.connecting;

    if (!this.context) {
      throw new Error("Browser harness failed to connect to Chrome over CDP");
    }
    return this.context;
  }

  private async connect(): Promise<void> {
    this.browser = await chromium.connectOverCDP(this.options.cdpUrl);
    this.context = this.browser.contexts()[0] ?? (await this.browser.newContext());

    this.page = this.context.pages().at(-1);
  }

  private async activePage(): Promise<Page> {
    const context = await this.ensureContext();
    if (!this.page || this.page.isClosed()) {
      await this.usePage(context.pages().at(-1) ?? (await context.newPage()));
    }
    if (!this.page) throw new Error("Browser harness has no active page");
    return this.page;
  }

  private async activeClient(): Promise<CDPSession> {
    const page = await this.activePage();
    if (!this.client || this.clientPage !== page) {
      this.client = await this.context!.newCDPSession(page);
      this.clientPage = page;
      await this.cdp("Page.enable");
      await this.cdp("Runtime.enable");
    }
    return this.client;
  }

  private async usePage(page: Page): Promise<void> {
    this.page = page;
    this.client = undefined;
    this.clientPage = undefined;
    await this.activeClient();
  }

  private async cdp<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const client = await this.activeClient();
    const sender = client as unknown as {
      send: (method: string, params?: Record<string, unknown>) => Promise<T>;
    };
    return sender.send(method, params);
  }

  private async clickAt(x: number, y: number): Promise<void> {
    const point = {
      x: Math.round(x),
      y: Math.round(y)
    };

    await this.cdp("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      ...point,
      button: "none",
      buttons: 0,
      pointerType: "mouse"
    });
    await this.cdp("Input.dispatchMouseEvent", {
      type: "mousePressed",
      ...point,
      button: "left",
      buttons: 1,
      clickCount: 1,
      pointerType: "mouse"
    });
    await this.cdp("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      ...point,
      button: "left",
      buttons: 0,
      clickCount: 1,
      pointerType: "mouse"
    });
  }

  private async pressKey(key: string): Promise<void> {
    const page = await this.activePage();
    await page.keyboard.press(key);
  }

  private async evaluateJavaScript(code: string): Promise<string> {
    const expression = isExpression(code) ? code.trim() : `(async () => {\n${code}\n})()`;
    const result = await this.cdp<RuntimeEvaluateResult>("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    });

    if (result.exceptionDetails) {
      const message =
        result.exceptionDetails.exception?.description ??
        result.exceptionDetails.exception?.value ??
        result.exceptionDetails.text ??
        "JavaScript evaluation failed";
      throw new Error(String(message));
    }

    return renderRemoteObject(result.result);
  }

  private async pageInfo(): Promise<string> {
    const page = await this.activePage();
    const viewport = page.viewportSize() ?? { width: 0, height: 0 };
    const readyState = await page.evaluate(() => document.readyState).catch(() => "unknown");
    const info: PageInfo = {
      url: page.url(),
      title: await page.title().catch(() => ""),
      viewport,
      readyState
    };

    return JSON.stringify(info, null, 2);
  }

  private async waitForLoad(timeoutMs: number): Promise<void> {
    const page = await this.activePage();
    await page.waitForLoadState("load", { timeout: timeoutMs }).catch(() => undefined);
  }

  private async settleAfterInput(): Promise<void> {
    await this.sleep(100);
    await this.waitForLoad(2_000);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

function isExpression(code: string): boolean {
  const trimmed = code.trim();
  if (!trimmed) return false;
  if (/[;\n]/.test(trimmed)) return false;
  if (/^(let|const|var|if|for|while|do|switch|class|function|throw|try|return|import|export)\b/.test(trimmed)) {
    return false;
  }
  return true;
}

function renderRemoteObject(remote: RuntimeRemoteObject): string {
  const value = remote.value ?? remote.unserializableValue;
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}
