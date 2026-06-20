import fs from "node:fs";
import CDP from "chrome-remote-interface";
import type { Protocol } from "devtools-protocol";

export type CdpSend = {
  send: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;
};

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

type RuntimeEvaluateResult = Protocol.Runtime.EvaluateResponse;
type RuntimeRemoteObject = Protocol.Runtime.RemoteObject;

const DEFAULT_VIEWPORT = { width: 1280, height: 720 };

export class CdpBrowserClient {
  private client?: CDP.Client;
  private target?: CDP.Target;
  private connecting?: Promise<void>;
  private requestById = new Map<string, { method: string; url: string }>();

  readonly consoleErrors: string[] = [];
  readonly failedRequests: string[] = [];

  constructor(private readonly options: BrowserHarnessOptions) {}

  async connect(): Promise<void> {
    if (!this.connecting) {
      this.connecting = this.open();
    }
    await this.connecting;
  }

  async close(): Promise<void> {
    await this.client?.close().catch(() => undefined);
    this.client = undefined;
    this.target = undefined;
    this.connecting = undefined;
  }

  async newPage(url: string): Promise<void> {
    await this.close();
    this.target = await CDP.New({ ...this.endpoint(), url: "about:blank" });
    this.connecting = this.open();
    await this.connecting;
    await this.pageSend("Page.navigate", { url });
    await this.waitForReadyState(30_000, "interactive");
  }

  async activePage(): Promise<CdpSend> {
    await this.ensurePage();
    return {
      send: (method, params) => this.pageSend(method, params)
    };
  }

  async ensurePage(): Promise<void> {
    await this.connect();
  }

  async pageSend<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    await this.connect();
    return this.rawSend<T>(method, params);
  }

  async evaluate<T = unknown>(expression: string, options: { awaitPromise?: boolean; userGesture?: boolean } = {}): Promise<T> {
    const result = await this.pageSend<RuntimeEvaluateResult>("Runtime.evaluate", {
      expression,
      awaitPromise: options.awaitPromise ?? true,
      returnByValue: true,
      userGesture: options.userGesture ?? true
    });
    if (result.exceptionDetails) {
      throw new Error(runtimeExceptionMessage(result.exceptionDetails));
    }
    return result.result.value as T;
  }

  async evaluateRemote(expression: string): Promise<RuntimeRemoteObject> {
    const result = await this.pageSend<RuntimeEvaluateResult>("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    });
    if (result.exceptionDetails) {
      throw new Error(runtimeExceptionMessage(result.exceptionDetails));
    }
    return result.result;
  }

  async captureScreenshot(filePath: string): Promise<boolean> {
    const result = await this.pageSend<Protocol.Page.CaptureScreenshotResponse>("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: true
    });
    if (!result.data) return false;
    fs.writeFileSync(filePath, Buffer.from(result.data, "base64"));
    return true;
  }

  async pageInfo(): Promise<string> {
    const info = await this.evaluate<PageInfo>(`(() => ({
      url: location.href,
      title: document.title,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      readyState: document.readyState
    }))()`).catch(() => ({
      url: this.target?.url ?? "",
      title: this.target?.title ?? "",
      viewport: DEFAULT_VIEWPORT,
      readyState: "unknown"
    }));
    return JSON.stringify(info, null, 2);
  }

  async waitForReadyState(timeoutMs: number, minimum: "interactive" | "complete" = "complete"): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = await this.evaluate<string>("document.readyState").catch(() => "");
      if (minimum === "interactive" ? state === "interactive" || state === "complete" : state === "complete") return;
      await sleep(100);
    }
  }

  async elementMatches(selector: string, textIncludes = ""): Promise<boolean> {
    return this.evaluate<boolean>(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      const visible = rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      const text = String(element.textContent ?? "") + " " + String(element.value ?? "");
      return visible && (!${JSON.stringify(textIncludes)} || text.replace(/\\s+/g, " ").includes(${JSON.stringify(textIncludes)}));
    })()`).catch(() => false);
  }

  async boundsForRef(ref: string, focus = false, select = false): Promise<{ x: number; y: number; width: number; height: number }> {
    const bounds = await this.evaluate<{ x: number; y: number; width: number; height: number } | undefined>(
      `(() => {
        const ref = ${JSON.stringify(ref)};
        const element = Array.from(document.querySelectorAll("[data-agentic-ref]"))
          .find((candidate) => candidate.getAttribute("data-agentic-ref") === ref);
        if (!element) return undefined;
        element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        const visible = rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
        if (!visible) return undefined;
        if (${JSON.stringify(focus)}) {
          element.focus({ preventScroll: true });
        }
        if (${JSON.stringify(select)}) {
          if (typeof element.select === "function") {
            element.select();
          } else {
            const range = document.createRange();
            range.selectNodeContents(element);
            const selection = window.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(range);
          }
        }
        return {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        };
      })()`
    );
    if (!bounds) throw new Error(`Element ref ${ref} is not visible`);
    return bounds;
  }

  private async open(): Promise<void> {
    this.target ??= await this.findActiveTarget();
    this.client = await CDP({ ...this.endpoint(), target: this.target });
    this.attachEventListeners(this.client);
    await this.rawSend("Page.enable");
    await this.rawSend("Runtime.enable");
    await this.rawSend("Network.enable");
    await this.rawSend("Log.enable").catch(() => undefined);
    await this.rawSend("Emulation.setDeviceMetricsOverride", {
      width: DEFAULT_VIEWPORT.width,
      height: DEFAULT_VIEWPORT.height,
      deviceScaleFactor: 1,
      mobile: false
    }).catch(() => undefined);
  }

  private attachEventListeners(client: CDP.Client): void {
    client.on("Runtime.consoleAPICalled", (params) => {
      if (params.type !== "error") return;
      const text = params.args.map(renderRemoteObject).filter(Boolean).join(" ");
      this.consoleErrors.push(`${new Date().toISOString()} ${text || "console.error"}`);
    });

    client.on("Runtime.exceptionThrown", (params) => {
      this.consoleErrors.push(
        `${new Date().toISOString()} ${params.exceptionDetails.exception?.description ?? params.exceptionDetails.text ?? "Uncaught exception"}`
      );
    });

    client.on("Network.requestWillBeSent", (params) => {
      this.requestById.set(params.requestId, {
        method: params.request.method,
        url: params.request.url
      });
    });

    client.on("Network.loadingFailed", (params) => {
      const failed = this.requestById.get(params.requestId);
      this.failedRequests.push(`${failed?.method ?? ""} ${failed?.url ?? params.requestId} ${params.errorText}`.trim());
    });

    client.on("disconnect", () => {
      this.client = undefined;
      this.connecting = undefined;
    });
  }

  private async findActiveTarget(): Promise<CDP.Target> {
    const targets = await CDP.List(this.endpoint());
    const pages = targets.filter((target) => target.type === "page" && target.url !== "chrome://newtab/");
    const meaningfulPage = pages.filter((target) => target.url && target.url !== "about:blank").at(-1);
    return meaningfulPage ?? pages.at(-1) ?? (await CDP.New({ ...this.endpoint(), url: "about:blank" }));
  }

  private endpoint(): CDP.BaseOptions {
    const url = new URL(this.options.cdpUrl);
    return {
      host: url.hostname,
      port: Number(url.port || 80),
      secure: url.protocol === "https:"
    };
  }

  private requireClient(): CDP.Client {
    if (!this.client) throw new Error("CDP client is not connected");
    return this.client;
  }

  private rawSend<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const client = this.requireClient();
    const send = client.send as unknown as (method: string, params?: Record<string, unknown>) => Promise<T>;
    return send.call(client, method, params);
  }
}

export function renderRemoteObject(remote: RuntimeRemoteObject): string {
  const value = remote.value ?? remote.unserializableValue;
  if (value === undefined || value === null) return remote.description ?? "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function runtimeExceptionMessage(exceptionDetails: Protocol.Runtime.ExceptionDetails): string {
  return String(
    exceptionDetails.exception?.description ??
      exceptionDetails.exception?.value ??
      exceptionDetails.text ??
      "JavaScript evaluation failed"
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
