import { CdpBrowserClient, renderRemoteObject } from "./cdp-client.js";

type BrowserControllerOptions = {
  cdpUrl: string;
};

export class BrowserController {
  private readonly browser: CdpBrowserClient;
  private connecting?: Promise<void>;

  constructor(options: BrowserControllerOptions) {
    this.browser = new CdpBrowserClient(options);
  }

  async navigate(url: string): Promise<string> {
    await this.ensureConnected();
    await this.browser.newPage(url);
    return this.browser.pageInfo();
  }

  async clickAt(x: number, y: number): Promise<string> {
    await this.ensureConnected();
    await this.dispatchClick(x, y);
    await this.settleAfterInput();
    return this.browser.pageInfo();
  }

  async clickRef(ref: string): Promise<string> {
    await this.ensureConnected();
    const box = await this.waitForRef(ref, false, false);
    await this.dispatchClick(box.x + box.width / 2, box.y + box.height / 2);
    await this.settleAfterInput();
    return this.browser.pageInfo();
  }

  async typeText(text: string): Promise<string> {
    await this.ensureConnected();
    await this.browser.pageSend("Input.insertText", { text });
    await this.settleAfterInput();
    return this.browser.pageInfo();
  }

  async typeRef(ref: string, text: string, clear = true): Promise<string> {
    await this.ensureConnected();
    await this.waitForRef(ref, true, clear);
    await this.browser.pageSend("Input.insertText", { text });
    await this.settleAfterInput();
    return this.browser.pageInfo();
  }

  async pressKey(key: string): Promise<string> {
    await this.ensureConnected();
    await this.press(key);
    await this.settleAfterInput();
    return this.browser.pageInfo();
  }

  async scroll(deltaY: number, x = 500, y = 500): Promise<string> {
    await this.ensureConnected();
    await this.browser.pageSend("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x,
      y,
      deltaX: 0,
      deltaY: Math.round(deltaY),
      pointerType: "mouse"
    });
    await this.settleAfterInput();
    return this.browser.pageInfo();
  }

  async wait(ms: number): Promise<string> {
    await this.ensureConnected();
    await sleep(Math.max(0, ms));
    await this.browser.waitForReadyState(5_000).catch(() => undefined);
    return this.browser.pageInfo();
  }

  async runJs(code: string): Promise<string> {
    await this.ensureConnected();
    const expression = isExpression(code) ? code.trim() : `(async () => {\n${code}\n})()`;
    const result = await this.browser.evaluateRemote(expression);
    return renderRemoteObject(result);
  }

  async probeDom(code: string): Promise<string> {
    await this.ensureConnected();
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

    const result = await this.browser.evaluateRemote(expression);
    return renderRemoteObject(result);
  }

  async elementMatches(selector: string, textIncludes?: string): Promise<boolean> {
    await this.ensureConnected();
    return this.browser.elementMatches(selector, textIncludes);
  }

  async close(): Promise<void> {
    await this.browser.close();
    this.connecting = undefined;
  }

  private async ensureConnected(): Promise<void> {
    if (!this.connecting) {
      this.connecting = this.browser.connect();
    }
    await this.connecting;
    await this.browser.ensurePage();
  }

  private async dispatchClick(x: number, y: number): Promise<void> {
    const point = {
      x: Math.round(x),
      y: Math.round(y)
    };

    await this.browser.pageSend("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      ...point,
      button: "none",
      buttons: 0,
      pointerType: "mouse"
    });
    await this.browser.pageSend("Input.dispatchMouseEvent", {
      type: "mousePressed",
      ...point,
      button: "left",
      buttons: 1,
      clickCount: 1,
      pointerType: "mouse"
    });
    await this.browser.pageSend("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      ...point,
      button: "left",
      buttons: 0,
      clickCount: 1,
      pointerType: "mouse"
    });
  }

  private async waitForRef(ref: string, focus: boolean, select: boolean): Promise<{ x: number; y: number; width: number; height: number }> {
    const deadline = Date.now() + 5_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        return await this.browser.boundsForRef(ref, focus, select);
      } catch (error) {
        lastError = error;
        await sleep(100);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`Element ref ${ref} is not visible`);
  }

  private async press(key: string): Promise<void> {
    const parts = key.split("+").map((part) => part.trim()).filter(Boolean);
    const main = parts.pop() ?? key;
    const modifierKeys = parts.map(normalizeModifier);
    const modifiers = modifierKeys.reduce((mask, modifier) => mask | modifier.bit, 0);

    for (const modifier of modifierKeys) {
      await this.dispatchKey("rawKeyDown", keyDefinition(modifier.key), 0);
    }

    const definition = keyDefinition(main);
    await this.dispatchKey(definition.text ? "keyDown" : "rawKeyDown", definition, modifiers);
    if (definition.text && !modifiers) {
      await this.dispatchKey("char", definition, modifiers);
    }
    await this.dispatchKey("keyUp", definition, modifiers);

    for (const modifier of [...modifierKeys].reverse()) {
      await this.dispatchKey("keyUp", keyDefinition(modifier.key), 0);
    }
  }

  private async dispatchKey(type: string, definition: KeyDefinition, modifiers: number): Promise<void> {
    await this.browser.pageSend("Input.dispatchKeyEvent", {
      type,
      key: definition.key,
      code: definition.code,
      windowsVirtualKeyCode: definition.windowsVirtualKeyCode,
      nativeVirtualKeyCode: definition.windowsVirtualKeyCode,
      text: type === "char" ? definition.text : undefined,
      unmodifiedText: type === "char" ? definition.text : undefined,
      modifiers
    });
  }

  private async settleAfterInput(): Promise<void> {
    await sleep(100);
    await this.browser.waitForReadyState(2_000).catch(() => undefined);
  }
}

type KeyDefinition = {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  text?: string;
};

function normalizeModifier(value: string): { key: string; bit: number } {
  const normalized = value.toLowerCase();
  if (normalized === "ctrl" || normalized === "control") return { key: "Control", bit: 2 };
  if (normalized === "alt" || normalized === "option") return { key: "Alt", bit: 1 };
  if (normalized === "meta" || normalized === "cmd" || normalized === "command") return { key: "Meta", bit: 4 };
  if (normalized === "shift") return { key: "Shift", bit: 8 };
  return { key: value, bit: 0 };
}

function keyDefinition(key: string): KeyDefinition {
  const normalized = key.length === 1 ? key : key.toLowerCase();
  const named: Record<string, KeyDefinition> = {
    enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
    tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
    escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
    backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
    delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
    arrowup: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
    arrowdown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
    arrowleft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
    arrowright: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
    home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
    end: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
    pageup: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
    pagedown: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
    control: { key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17 },
    alt: { key: "Alt", code: "AltLeft", windowsVirtualKeyCode: 18 },
    shift: { key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16 },
    meta: { key: "Meta", code: "MetaLeft", windowsVirtualKeyCode: 91 }
  };
  if (named[normalized]) return named[normalized];

  if (/^[a-zA-Z]$/.test(key)) {
    const upper = key.toUpperCase();
    return { key, code: `Key${upper}`, windowsVirtualKeyCode: upper.charCodeAt(0), text: key };
  }
  if (/^[0-9]$/.test(key)) {
    return { key, code: `Digit${key}`, windowsVirtualKeyCode: key.charCodeAt(0), text: key };
  }
  return { key, code: key, windowsVirtualKeyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0 };
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
