import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import { startChrome, type ChromeSession } from "../browser/chrome-manager.js";
import { BrowserController } from "../browser/browser-controller.js";
import { CdpObserver } from "../browser/cdp-observer.js";

type BrowserState = {
  cdpUrl?: string;
  chrome?: ChromeSession;
  controller?: BrowserController;
  observer?: CdpObserver;
  observeCount: number;
};

const state: BrowserState = {
  observeCount: 0
};

const server = new McpServer({
  name: "browser-change-verifier",
  version: "0.1.0"
});

server.registerTool(
  "browser_start",
  {
    title: "Start Browser",
    description: "Start a Chrome browser controlled through CDP, or connect to an existing CDP endpoint.",
    inputSchema: {
      headless: z.boolean().optional().describe("Start Chrome headless when cdpUrl is not provided. Defaults to true."),
      cdpUrl: z.string().optional().describe("Existing Chrome DevTools endpoint, such as http://127.0.0.1:9222.")
    }
  },
  async ({ headless = true, cdpUrl }) => {
    await resetBrowser();
    if (cdpUrl) {
      state.cdpUrl = cdpUrl;
    } else {
      state.chrome = await startChrome({ headless });
      state.cdpUrl = state.chrome.cdpUrl;
    }

    state.controller = new BrowserController({ cdpUrl: state.cdpUrl });
    state.observer = await CdpObserver.connect(state.cdpUrl);
    state.observeCount = 0;

    return textResult({
      ok: true,
      cdpUrl: state.cdpUrl,
      headless: cdpUrl ? undefined : headless
    });
  }
);

server.registerTool(
  "browser_navigate",
  {
    title: "Navigate Browser",
    description: "Open a new browser page at the given URL.",
    inputSchema: {
      url: z.string().url().describe("URL to open.")
    }
  },
  async ({ url }) => {
    const info = await requireController().navigate(url);
    await state.observer?.close().catch(() => undefined);
    state.observer = await CdpObserver.connect(requireCdpUrl());
    state.observeCount = 0;
    return textResult(info);
  }
);

server.registerTool(
  "browser_observe",
  {
    title: "Observe Browser",
    description:
      "Observe the current page with a screenshot-path-first result. Returns screenshot path, URL, title, visible text, aria tree/nodes, console errors, and failed requests. The screenshot image is omitted by default to preserve agent context.",
    inputSchema: {
      artifactDir: z.string().optional().describe("Directory for screenshots. Defaults to artifacts/browser-change-verifier."),
      includeVisibleText: z.boolean().optional().describe("Include visible page text. Defaults to true."),
      includeScreenshotImage: z.boolean().optional().describe("Attach the screenshot image to the tool result for manual visual analysis. Defaults to false; prefer analyze_screenshot with screenshotPath.")
    }
  },
  async ({ artifactDir, includeVisibleText = true, includeScreenshotImage = false }) => {
    const observer = requireObserver();
    state.observeCount += 1;
    const dir = path.resolve(artifactDir ?? "artifacts/browser-change-verifier");
    const observation = await observer.observe(dir, state.observeCount);
    const summary = {
      ...observation,
      visibleText: includeVisibleText ? observation.visibleText : undefined,
      consoleErrors: observation.consoleErrors.slice(-20),
      failedRequests: observation.failedRequests.slice(-20)
    };

    const content: ContentBlock[] = [
      {
        type: "text",
        text: JSON.stringify(summary, null, 2)
      }
    ];

    if (includeScreenshotImage && observation.screenshotPath && fs.existsSync(observation.screenshotPath)) {
      content.push({
        type: "image",
        data: fs.readFileSync(observation.screenshotPath).toString("base64"),
        mimeType: "image/png"
      });
    }

    return { content };
  }
);

server.registerTool(
  "browser_click_ref",
  {
    title: "Click Element Ref",
    description: "Click an element by ref from browser_observe ariaNodes or browser_probe_dom nodes.",
    inputSchema: {
      ref: z.string().describe("Element ref such as e1 or j2.")
    }
  },
  async ({ ref }) => textResult(await requireController().clickRef(ref))
);

server.registerTool(
  "browser_click_xy",
  {
    title: "Click Coordinates",
    description: "Click viewport coordinates. Use only when element refs and DOM probing are insufficient.",
    inputSchema: {
      x: z.number().describe("Viewport x coordinate."),
      y: z.number().describe("Viewport y coordinate.")
    }
  },
  async ({ x, y }) => textResult(await requireController().clickAt(x, y))
);

server.registerTool(
  "browser_type_ref",
  {
    title: "Type Into Element Ref",
    description: "Focus an element ref, optionally clear it, and type text.",
    inputSchema: {
      ref: z.string().describe("Element ref such as e1 or j2."),
      text: z.string().describe("Text to type."),
      clear: z.boolean().optional().describe("Clear current contents first. Defaults to true.")
    }
  },
  async ({ ref, text, clear = true }) => textResult(await requireController().typeRef(ref, text, clear))
);

server.registerTool(
  "browser_type_text",
  {
    title: "Type Text",
    description: "Type text into the currently focused element.",
    inputSchema: {
      text: z.string().describe("Text to type.")
    }
  },
  async ({ text }) => textResult(await requireController().typeText(text))
);

server.registerTool(
  "browser_press_key",
  {
    title: "Press Key",
    description: "Press a key or shortcut, such as Enter, Tab, Escape, ArrowDown, or Ctrl+A.",
    inputSchema: {
      key: z.string().describe("Key or shortcut to press.")
    }
  },
  async ({ key }) => textResult(await requireController().pressKey(key))
);

server.registerTool(
  "browser_scroll",
  {
    title: "Scroll Page",
    description: "Scroll the page by a wheel delta.",
    inputSchema: {
      deltaY: z.number().describe("Positive values scroll down; negative values scroll up."),
      x: z.number().optional().describe("Viewport x coordinate for the wheel event. Defaults to 500."),
      y: z.number().optional().describe("Viewport y coordinate for the wheel event. Defaults to 500.")
    }
  },
  async ({ deltaY, x = 500, y = 500 }) => textResult(await requireController().scroll(deltaY, x, y))
);

server.registerTool(
  "browser_wait",
  {
    title: "Wait For UI",
    description: "Wait for the UI to settle.",
    inputSchema: {
      ms: z.number().min(0).max(30000).describe("Milliseconds to wait.")
    }
  },
  async ({ ms }) => textResult(await requireController().wait(ms))
);

server.registerTool(
  "browser_run_js",
  {
    title: "Run JavaScript",
    description: "Run JavaScript in the current page for inspection. Prefer visible browser actions for user-flow verification.",
    inputSchema: {
      code: z.string().describe("JavaScript expression or async function body.")
    }
  },
  async ({ code }) => textResult(await requireController().runJs(code))
);

server.registerTool(
  "browser_probe_dom",
  {
    title: "Probe DOM",
    description: [
      "Run a DOM probe in the page and optionally register actionable refs.",
      "The script runs inside an async function with helpers:",
      "one(selector), all(selector), byText(text, selector?), describe(element, metadata?), ref(element, metadata?).",
      "Call ref(element, metadata) for useful nodes, then use browser_click_ref or browser_type_ref."
    ].join(" "),
    inputSchema: {
      code: z.string().describe("JavaScript function body. Use return for summaries and ref(...) for actionable nodes.")
    }
  },
  async ({ code }) => textResult(await requireController().probeDom(code))
);

server.registerTool(
  "browser_close",
  {
    title: "Close Browser",
    description: "Close the controlled browser session.",
    inputSchema: {}
  },
  async () => {
    await resetBrowser();
    return textResult({ ok: true });
  }
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("browser-change-verifier MCP server running on stdio");
}

function requireController(): BrowserController {
  if (!state.controller) {
    throw new Error("Browser is not started. Call browser_start first.");
  }
  return state.controller;
}

function requireObserver(): CdpObserver {
  if (!state.observer) {
    throw new Error("Browser is not started. Call browser_start first.");
  }
  return state.observer;
}

function requireCdpUrl(): string {
  if (!state.cdpUrl) {
    throw new Error("Browser is not started. Call browser_start first.");
  }
  return state.cdpUrl;
}

async function resetBrowser(): Promise<void> {
  await state.observer?.close().catch(() => undefined);
  await state.controller?.close().catch(() => undefined);
  await state.chrome?.close().catch(() => undefined);
  state.cdpUrl = undefined;
  state.chrome = undefined;
  state.controller = undefined;
  state.observer = undefined;
  state.observeCount = 0;
}

function textResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2)
      }
    ]
  };
}

process.on("SIGINT", () => {
  resetBrowser().finally(() => process.exit(130));
});

process.on("SIGTERM", () => {
  resetBrowser().finally(() => process.exit(143));
});

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
