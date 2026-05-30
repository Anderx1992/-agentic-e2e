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
      case "clickRef":
        await this.clickRef(action.ref);
        await this.settleAfterInput();
        return this.pageInfo();
      case "type":
        await this.cdp("Input.insertText", { text: action.text });
        await this.settleAfterInput();
        return this.pageInfo();
      case "typeRef":
        await this.typeIntoRef(action.ref, action.text, action.clear ?? true);
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
      case "probeDom":
        return this.probeDom(action.code);
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

  private async clickRef(ref: string): Promise<void> {
    const page = await this.activePage();
    const locator = page.locator(`[data-agentic-ref="${escapeAttribute(ref)}"]`).first();
    await locator.waitFor({ state: "visible", timeout: 5_000 });
    const box = await locator.boundingBox();
    if (!box) throw new Error(`Element ref ${ref} is not visible`);
    await this.clickAt(box.x + box.width / 2, box.y + box.height / 2);
  }

  private async typeIntoRef(ref: string, text: string, clear: boolean): Promise<void> {
    const page = await this.activePage();
    const locator = page.locator(`[data-agentic-ref="${escapeAttribute(ref)}"]`).first();
    await locator.waitFor({ state: "visible", timeout: 5_000 });
    await locator.focus();
    if (clear) {
      await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    }
    await this.cdp("Input.insertText", { text });
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

  private async probeDom(code: string): Promise<string> {
    const expression = `(async () => {
      const findings = [];
      const win = window;
      win.__agenticE2ERefs ||= new Map();
      win.__agenticE2EProbeCounter ||= 0;

      const trim = (value, max = 300) => {
        const text = String(value ?? "").replace(/\\s+/g, " ").trim();
        return text.length <= max ? text : text.slice(0, max - 1) + "...";
      };

      const attrEscape = (value) => String(value).replace(/\\\\/g, "\\\\\\\\").replace(/"/g, "\\\\\"");
      const cssEscape = (value) => win.CSS?.escape ? win.CSS.escape(String(value)) : String(value).replace(/[^a-zA-Z0-9_-]/g, "\\\\$&");
      const selectorFor = (element) => {
        if (!(element instanceof Element)) return "";
        if (element.id) return "#" + cssEscape(element.id);
        const testId = element.getAttribute("data-testid") || element.getAttribute("data-test-id") || element.getAttribute("data-cy");
        if (testId) return '[data-testid="' + attrEscape(testId) + '"]';
        const parts = [];
        let current = element;
        while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {
          const tag = current.tagName.toLowerCase();
          const parent = current.parentElement;
          if (!parent) {
            parts.unshift(tag);
            break;
          }
          const siblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
          const index = siblings.indexOf(current) + 1;
          parts.unshift(siblings.length > 1 ? tag + ":nth-of-type(" + index + ")" : tag);
          current = parent;
          if (parts.length >= 4) break;
        }
        return parts.join(" > ");
      };

      const describe = (element, metadata = {}) => {
        if (!(element instanceof Element)) return undefined;
        const rect = element.getBoundingClientRect();
        const style = win.getComputedStyle(element);
        const input = element;
        return {
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute("role") || undefined,
          ariaLabel: element.getAttribute("aria-label") || undefined,
          name: element.getAttribute("name") || undefined,
          id: element.id || undefined,
          selector: selectorFor(element),
          text: trim(element.innerText || element.textContent || ""),
          value: "value" in input ? trim(input.value) : undefined,
          placeholder: "placeholder" in input ? trim(input.placeholder, 120) : undefined,
          type: "type" in input ? String(input.type || "") : undefined,
          disabled: "disabled" in input ? Boolean(input.disabled) : undefined,
          visible: rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none",
          bounds: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          },
          ...metadata
        };
      };

      const ref = (element, metadata = {}) => {
        if (!(element instanceof Element)) return undefined;
        const id = "j" + (++win.__agenticE2EProbeCounter);
        win.__agenticE2ERefs.set(id, element);
        element.setAttribute("data-agentic-ref", id);
        const summary = { ref: id, ...describe(element, metadata) };
        findings.push(summary);
        return id;
      };

      const all = (selector, root = document) => Array.from(root.querySelectorAll(selector));
      const one = (selector, root = document) => root.querySelector(selector);
      const byText = (text, selector = "body *") => {
        const needle = String(text).toLowerCase();
        return all(selector).filter((element) => trim(element.innerText || element.textContent || "").toLowerCase().includes(needle));
      };
      const simplify = (value) => {
        if (value instanceof Element) return describe(value);
        if (Array.isArray(value)) return value.slice(0, 50).map(simplify);
        if (value && typeof value === "object") {
          return Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, item]) => [key, simplify(item)]));
        }
        return value;
      };

      const result = await (async () => {
${code}
      })();

      return { result: simplify(result), nodes: findings.slice(0, 100) };
    })()`;

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
        "DOM probe failed";
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

function escapeAttribute(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
