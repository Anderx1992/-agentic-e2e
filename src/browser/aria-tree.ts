import type { CDPSession, Page } from "@playwright/test";
import type { AriaNodeSummary } from "./observation.js";

type AXValue = {
  type?: string;
  value?: unknown;
};

type AXProperty = {
  name?: string;
  value?: AXValue;
};

type AXNode = {
  nodeId: string;
  ignored?: boolean;
  role?: AXValue;
  name?: AXValue;
  value?: AXValue;
  description?: AXValue;
  properties?: AXProperty[];
  childIds?: string[];
  backendDOMNodeId?: number;
};

type FullAXTreeResult = {
  nodes: AXNode[];
};

type ResolveNodeResult = {
  object: {
    objectId?: string;
  };
};

type RuntimeCallResult = {
  result: {
    value?: unknown;
    description?: string;
  };
  exceptionDetails?: {
    text?: string;
    exception?: {
      description?: string;
      value?: unknown;
    };
  };
};

type DomDescription = Omit<AriaNodeSummary, "role" | "name" | "ref"> & {
  visible: boolean;
  interactive: boolean;
};

const MAX_ARIA_NODES = 120;
const MAX_TREE_LINES = 180;

const ACTIONABLE_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
  "treeitem"
]);

const STRUCTURAL_ROLES = new Set([
  "alert",
  "cell",
  "columnheader",
  "dialog",
  "gridcell",
  "heading",
  "listitem",
  "row",
  "rowheader"
]);

export async function collectAriaTree(page: Page): Promise<{
  ariaTree: string;
  ariaNodes: AriaNodeSummary[];
}> {
  const client = await page.context().newCDPSession(page);

  try {
    await send(client, "Accessibility.enable").catch(() => undefined);
    const tree = await send<FullAXTreeResult>(client, "Accessibility.getFullAXTree");
    const nodes = tree.nodes.filter((node) => !node.ignored);
    const byId = new Map(nodes.map((node) => [node.nodeId, node]));
    const summarizedById = new Map<string, AriaNodeSummary>();
    const ariaNodes: AriaNodeSummary[] = [];

    for (const node of nodes) {
      if (ariaNodes.length >= MAX_ARIA_NODES) break;
      if (!node.backendDOMNodeId || !isWorthReferencing(node)) continue;

      const ref = `e${ariaNodes.length + 1}`;
      const dom = await describeBackendNode(client, node.backendDOMNodeId, ref).catch(() => undefined);
      if (!dom?.visible) continue;
      if (!dom.interactive && !isUsefulStructuralNode(node)) continue;

      const summary: AriaNodeSummary = {
        ref,
        role: axString(node.role),
        name: axString(node.name),
        tag: dom.tag,
        selector: dom.selector,
        text: dom.text,
        value: dom.value,
        placeholder: dom.placeholder,
        type: dom.type,
        disabled: booleanProperty(node, "disabled") || dom.disabled,
        checked: booleanProperty(node, "checked"),
        expanded: booleanProperty(node, "expanded"),
        selected: booleanProperty(node, "selected"),
        bounds: dom.bounds
      };

      summarizedById.set(node.nodeId, summary);
      ariaNodes.push(summary);
    }

    const rootIds = findRootIds(nodes);
    const lines = rootIds.flatMap((id) => renderNode(byId, summarizedById, id, 0));
    const ariaTree = lines.slice(0, MAX_TREE_LINES).join("\n");

    return {
      ariaTree,
      ariaNodes
    };
  } finally {
    await client.detach().catch(() => undefined);
  }
}

async function describeBackendNode(
  client: CDPSession,
  backendNodeId: number,
  ref: string
): Promise<DomDescription | undefined> {
  const resolved = await send<ResolveNodeResult>(client, "DOM.resolveNode", { backendNodeId });
  const objectId = resolved.object.objectId;
  if (!objectId) return undefined;

  try {
    const result = await send<RuntimeCallResult>(client, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: describeElementFunction,
      arguments: [{ value: ref }],
      returnByValue: true
    });

    if (result.exceptionDetails) {
      const message =
        result.exceptionDetails.exception?.description ??
        result.exceptionDetails.exception?.value ??
        result.exceptionDetails.text ??
        "Unable to describe DOM node";
      throw new Error(String(message));
    }

    return result.result.value as DomDescription | undefined;
  } finally {
    await send(client, "Runtime.releaseObject", { objectId }).catch(() => undefined);
  }
}

function renderNode(
  byId: Map<string, AXNode>,
  summarizedById: Map<string, AriaNodeSummary>,
  id: string,
  depth: number
): string[] {
  const node = byId.get(id);
  if (!node) return [];

  const childLines = (node.childIds ?? []).flatMap((childId) => renderNode(byId, summarizedById, childId, depth + 1));
  const summary = summarizedById.get(id);
  const role = axString(node.role);
  const name = axString(node.name);
  const include = summary || isUsefulStructuralNode(node) || role === "RootWebArea" || role === "document";

  if (!include) return childLines;

  const parts = [`${"  ".repeat(depth)}- ${role || "node"}`];
  if (name) parts.push(JSON.stringify(trim(name, 120)));
  if (summary) {
    parts.push(`[ref=${summary.ref}]`);
    parts.push(`<${summary.tag}>`);
    if (summary.disabled) parts.push("[disabled]");
    if (summary.checked !== undefined) parts.push(`[checked=${summary.checked}]`);
    if (summary.expanded !== undefined) parts.push(`[expanded=${summary.expanded}]`);
  }

  return [parts.join(" "), ...childLines];
}

function findRootIds(nodes: AXNode[]): string[] {
  const childIds = new Set(nodes.flatMap((node) => node.childIds ?? []));
  const roots = nodes.filter((node) => !childIds.has(node.nodeId));
  return (roots.length ? roots : nodes.slice(0, 1)).map((node) => node.nodeId);
}

function isWorthReferencing(node: AXNode): boolean {
  const role = axString(node.role);
  const name = axString(node.name);
  return ACTIONABLE_ROLES.has(role) || isEditable(node) || isUsefulStructuralNode(node) || Boolean(name);
}

function isUsefulStructuralNode(node: AXNode): boolean {
  const role = axString(node.role);
  const name = axString(node.name);
  return STRUCTURAL_ROLES.has(role) && Boolean(name);
}

function isEditable(node: AXNode): boolean {
  return booleanProperty(node, "editable") || axString(node.role) === "textbox" || axString(node.role) === "searchbox";
}

function booleanProperty(node: AXNode, name: string): boolean | undefined {
  const value = node.properties?.find((property) => property.name === name)?.value?.value;
  return typeof value === "boolean" ? value : undefined;
}

function axString(value: AXValue | undefined): string {
  if (value?.value === undefined || value.value === null) return "";
  return String(value.value);
}

function trim(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}...`;
}

async function send<T = unknown>(
  client: CDPSession,
  method: string,
  params: Record<string, unknown> = {}
): Promise<T> {
  const sender = client as unknown as {
    send: (method: string, params?: Record<string, unknown>) => Promise<T>;
  };
  return sender.send(method, params);
}

const describeElementFunction = String(function describeElement(this: Node, ref: string) {
  const node = this;
  const element = (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement) as HTMLElement | null;
  if (!element) return undefined;

  const win = element.ownerDocument.defaultView;
  if (!win) return undefined;

  const rect = element.getBoundingClientRect();
  const style = win.getComputedStyle(element);
  const visible =
    rect.width > 0 &&
    rect.height > 0 &&
    style.visibility !== "hidden" &&
    style.display !== "none" &&
    Number(style.opacity || "1") > 0;

  const global = win as typeof window & {
    __agenticE2ERefs?: Map<string, HTMLElement>;
  };
  global.__agenticE2ERefs ??= new Map<string, HTMLElement>();
  global.__agenticE2ERefs.set(ref, element);
  element.setAttribute("data-agentic-ref", ref);

  const tag = element.tagName.toLowerCase();
  const input = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  const text = (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 300);
  const roleAttribute = element.getAttribute("role") || "";
  const interactive =
    ["a", "button", "input", "select", "textarea", "summary", "option"].includes(tag) ||
    Boolean(roleAttribute) ||
    element.tabIndex >= 0 ||
    style.cursor === "pointer";

  return {
    tag,
    selector: buildSelector(element),
    text,
    value: "value" in input ? String(input.value ?? "").slice(0, 300) : undefined,
    placeholder: "placeholder" in input ? String(input.placeholder ?? "").slice(0, 120) : undefined,
    type: "type" in input ? String(input.type ?? "") : undefined,
    disabled: "disabled" in input ? Boolean(input.disabled) : undefined,
    visible,
    interactive,
    bounds: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    }
  };

  function buildSelector(target: Element): string {
    if (target.id) return `#${cssEscape(target.id)}`;
    const testId =
      target.getAttribute("data-testid") ||
      target.getAttribute("data-test-id") ||
      target.getAttribute("data-cy");
    if (testId) return `[data-testid="${attrEscape(testId)}"]`;

    const parts: string[] = [];
    let current: Element | null = target;
    while (current && current.nodeType === Node.ELEMENT_NODE && current !== current.ownerDocument.body) {
      const tagName = current.tagName.toLowerCase();
      const parent: Element | null = current.parentElement;
      if (!parent) {
        parts.unshift(tagName);
        break;
      }
      const siblings = Array.from(parent.children).filter((child: Element) => child.tagName === current!.tagName);
      const index = siblings.indexOf(current) + 1;
      parts.unshift(siblings.length > 1 ? `${tagName}:nth-of-type(${index})` : tagName);
      current = parent;
      if (parts.length >= 4) break;
    }
    return parts.join(" > ");
  }

  function cssEscape(value: string): string {
    const css = (win as typeof window & { CSS?: { escape?: (input: string) => string } }).CSS;
    return css?.escape ? css.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function attrEscape(value: string): string {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }
});
