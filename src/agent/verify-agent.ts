import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query, type SDKMessage, type SDKResultMessage, type PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { resolveClaudeCodeExecutable } from "./claude-code.js";
import { loadAgentModelConfig, type AgentModelConfig } from "./settings.js";

export type VerifyChangeInput = {
  instruction?: string;
  appUrl?: string;
  startCommand?: string;
  headless?: boolean;
  artifactDir?: string;
  maxTurns?: number;
  timeoutMs?: number;
  permissionMode?: PermissionMode;
};

export type VerifyChangeResult = {
  summary: string;
  modelConfig: AgentModelConfig;
  claudeCodeExecutable?: string;
  sessionId?: string;
  stopReason?: string | null;
  terminalReason?: string;
  totalCostUsd?: number;
  messages: string[];
};

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export async function runBrowserChangeAgent(input: VerifyChangeInput, cwd = process.cwd()): Promise<VerifyChangeResult> {
  const modelConfig = await loadAgentModelConfig(cwd);
  const messages: string[] = [];
  let finalResult: SDKResultMessage | undefined;

  const settingsOption = modelConfig.settingsExists ? modelConfig.settingsPath : undefined;
  const claudeCodeExecutable = resolveClaudeCodeExecutable();
  const maxTurns = input.maxTurns ?? 30;
  const permissionMode = input.permissionMode ?? "dontAsk";

  const run = query({
    prompt: buildPrompt(input, modelConfig),
    options: {
      cwd,
      maxTurns,
      model: modelConfig.model,
      fallbackModel: modelConfig.fallbackModel,
      pathToClaudeCodeExecutable: claudeCodeExecutable,
      settings: settingsOption,
      settingSources: ["user", "project", "local"],
      tools: ["Read", "Grep", "Glob", "Bash"],
      allowedTools: [
        "Read",
        "Grep",
        "Glob",
        "Bash",
        "mcp__browser-change-verifier__browser_start",
        "mcp__browser-change-verifier__browser_navigate",
        "mcp__browser-change-verifier__browser_observe",
        "mcp__browser-change-verifier__browser_click_ref",
        "mcp__browser-change-verifier__browser_click_xy",
        "mcp__browser-change-verifier__browser_type_ref",
        "mcp__browser-change-verifier__browser_type_text",
        "mcp__browser-change-verifier__browser_press_key",
        "mcp__browser-change-verifier__browser_scroll",
        "mcp__browser-change-verifier__browser_wait",
        "mcp__browser-change-verifier__browser_run_js",
        "mcp__browser-change-verifier__browser_probe_dom",
        "mcp__browser-change-verifier__browser_close",
        "mcp__browser-vision-analyzer__analyze_screenshot"
      ],
      permissionMode,
      mcpServers: {
        "browser-change-verifier": {
          type: "stdio",
          command: "node",
          args: mcpServerArgs("server"),
          timeout: 600000,
          alwaysLoad: true
        },
        "browser-vision-analyzer": {
          type: "stdio",
          command: "node",
          args: mcpServerArgs("vision-server", "src/mcp/vision-server.ts"),
          timeout: 600000,
          alwaysLoad: true
        }
      },
      strictMcpConfig: true,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: systemAppend()
      },
      env: {
        ...process.env,
        CLAUDE_AGENT_SDK_CLIENT_APP: "browser-change-verifier/0.1.0"
      },
      title: "Browser change verification"
    }
  });

  const timeout = setTimeout(() => run.close(), input.timeoutMs ?? 10 * 60_000);
  try {
    for await (const message of run) {
      const text = messageToText(message);
      if (text) messages.push(text);
      if (message.type === "result") finalResult = message;
    }
  } finally {
    clearTimeout(timeout);
  }

  return {
    summary: finalResult?.type === "result" && finalResult.subtype === "success" ? finalResult.result : messages.at(-1) ?? "",
    modelConfig,
    claudeCodeExecutable,
    sessionId: finalResult?.session_id,
    stopReason: finalResult?.type === "result" && finalResult.subtype === "success" ? finalResult.stop_reason : undefined,
    terminalReason: finalResult?.type === "result" && finalResult.subtype === "success" ? finalResult.terminal_reason : undefined,
    totalCostUsd: finalResult?.type === "result" && finalResult.subtype === "success" ? finalResult.total_cost_usd : undefined,
    messages: messages.slice(-20)
  };
}

function mcpServerArgs(bundleName: "server" | "vision-server", sourceEntry = "src/mcp/server.ts"): string[] {
  const bundled = path.join(pluginRoot, "dist", "mcp", `${bundleName}.mjs`);
  if (fs.existsSync(bundled)) return [bundled];
  return [path.join(pluginRoot, "scripts", "start-mcp.mjs"), sourceEntry];
}

function buildPrompt(input: VerifyChangeInput, modelConfig: AgentModelConfig): string {
  return JSON.stringify(
    {
      task: "Verify the current frontend code changes in a real browser.",
      userInstruction: input.instruction ?? "Inspect the current git diff, infer the affected browser scenario, and verify it.",
      appUrl: input.appUrl,
      startCommand: input.startCommand,
      browser: {
        headless: input.headless ?? true,
        artifactDir: input.artifactDir ?? "artifacts/browser-change-verifier"
      },
      modelConfig: {
        settingsPath: modelConfig.settingsPath,
        settingsExists: modelConfig.settingsExists,
        source: modelConfig.source,
        model: modelConfig.model,
        fallbackModel: modelConfig.fallbackModel
      },
      requiredWorkflow: [
        "Inspect git diff/stat and relevant files before opening the browser.",
        "If startCommand is provided, use it. Otherwise infer the app dev or preview command from project files.",
        "If appUrl is provided, use it. Otherwise infer or discover the local URL from the running app.",
        "Call browser_start before browser tools. Use the requested headless value.",
        "Use browser_observe before visible actions.",
        "Prioritize screenshot-based visual analysis.",
        "For visual changes or ambiguous screenshots, call analyze_screenshot with screenshotPath and a focused prompt.",
        "Use ariaNodes refs for clicks/typing after visual target identification.",
        "Report route, actions, screenshot evidence, vision-model findings when used, console errors, failed requests, blockers, and final pass/fail/blocked judgment.",
        "Close the browser unless keeping it open is necessary to explain a blocker."
      ]
    },
    null,
    2
  );
}

function systemAppend(): string {
  return [
    "You are a browser change verification agent.",
    "Your job is to inspect code changes, infer a practical browser scenario, and verify the change in Chrome.",
    "Use screenshot-first visual analysis. DOM, aria, and JavaScript inspection are supporting tools, not the primary evidence for visible behavior.",
    "Do not edit files. Do not run destructive shell commands. Avoid commands that mutate git state.",
    "When using Bash, prefer read-only inspection commands and the project's normal dev/preview/test commands.",
    "Use Chinese for final summaries unless the user requested another language."
  ].join("\n");
}

function messageToText(message: SDKMessage): string {
  if (message.type === "result" && message.subtype === "success") return message.result;
  if (message.type !== "assistant") return "";
  return message.message.content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "tool_use") return `[tool_use:${block.name}]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}
