import fs from "node:fs";
import path from "node:path";
import { query, type SDKMessage, type SDKResultMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { resolveClaudeCodeExecutable } from "../agent/claude-code.js";
import { loadAgentModelConfig, type AgentModelConfig } from "../agent/settings.js";

type ImageMimeType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

type VisionAnalysis = {
  runtime: "claude-agent-sdk";
  modelConfig: Pick<AgentModelConfig, "settingsPath" | "settingsExists" | "source" | "model" | "fallbackModel">;
  claudeCodeExecutable?: string;
  analysis: string;
  sessionId?: string;
  stopReason?: string | null;
  terminalReason?: string;
  totalCostUsd?: number;
  image: {
    source: "path" | "base64";
    mimeType: ImageMimeType;
    bytes: number;
    screenshotPath?: string;
  };
};

const DEFAULT_PROMPT = [
  "Analyze this browser screenshot for frontend verification.",
  "Focus on what a user can see: layout, labels, visible state, form validation, disabled/enabled controls, loading or error states, spacing, and obvious visual regressions.",
  "If the user supplied expected behavior, compare the screenshot against it.",
  "Return concise findings with pass/fail/blocker signals and any uncertainty."
].join("\n");

const server = new McpServer({
  name: "browser-vision-analyzer",
  version: "0.1.0"
});

server.registerTool(
  "analyze_screenshot",
  {
    title: "Analyze Screenshot With Claude Agent SDK",
    description: "Analyze a browser screenshot through Claude Agent SDK. Accepts a screenshot path or base64 image.",
    inputSchema: {
      screenshotPath: z.string().optional().describe("Path to a screenshot file, usually from browser_observe.screenshotPath."),
      imageBase64: z.string().optional().describe("Base64 image data. Used when screenshotPath is not provided."),
      mimeType: z.string().optional().describe("Image MIME type. Defaults to image/png."),
      prompt: z.string().optional().describe("Specific visual verification question or expected behavior."),
      model: z.string().optional().describe("Optional SDK model override. Defaults to ~/.claude/settings.json, then CLAUDE_MODEL, then SDK default."),
      maxTurns: z.number().int().min(1).max(5).optional().describe("Maximum SDK agent turns. Defaults to 1."),
      timeoutMs: z.number().int().min(1000).max(300000).optional().describe("Timeout for the SDK analysis. Defaults to 120000.")
    }
  },
  async ({ screenshotPath, imageBase64, mimeType = "image/png", prompt, model, maxTurns = 1, timeoutMs = 120000 }) => {
    const image = readImage({ screenshotPath, imageBase64, mimeType });
    const modelConfig = await loadAgentModelConfig(process.cwd());
    const claudeCodeExecutable = resolveClaudeCodeExecutable();
    const analysis = await analyzeWithClaudeAgentSdk(image.base64, image.mimeType, prompt ?? DEFAULT_PROMPT, modelConfig, {
      model,
      maxTurns,
      timeoutMs,
      claudeCodeExecutable
    });

    const result: VisionAnalysis = {
      runtime: "claude-agent-sdk",
      modelConfig: {
        settingsPath: modelConfig.settingsPath,
        settingsExists: modelConfig.settingsExists,
        source: modelConfig.source,
        model: model ?? modelConfig.model,
        fallbackModel: modelConfig.fallbackModel
      },
      claudeCodeExecutable,
      analysis: analysis.text,
      sessionId: analysis.result?.session_id,
      stopReason: analysis.result?.type === "result" && analysis.result.subtype === "success" ? analysis.result.stop_reason : undefined,
      terminalReason:
        analysis.result?.type === "result" && analysis.result.subtype === "success" ? analysis.result.terminal_reason : undefined,
      totalCostUsd: analysis.result?.type === "result" && analysis.result.subtype === "success" ? analysis.result.total_cost_usd : undefined,
      image: {
        source: screenshotPath ? "path" : "base64",
        mimeType: image.mimeType,
        bytes: Buffer.byteLength(image.base64, "base64"),
        screenshotPath: screenshotPath ? path.resolve(screenshotPath) : undefined
      }
    };

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2)
        }
      ]
    };
  }
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("browser-vision-analyzer MCP server running on stdio");
}

function readImage(input: { screenshotPath?: string; imageBase64?: string; mimeType: string }): { base64: string; mimeType: ImageMimeType } {
  if (input.screenshotPath) {
    const filePath = path.resolve(input.screenshotPath);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Screenshot does not exist: ${filePath}`);
    }
    return {
      base64: fs.readFileSync(filePath).toString("base64"),
      mimeType: inferMimeType(filePath, input.mimeType)
    };
  }

  if (input.imageBase64) {
    return {
      base64: stripDataUrl(input.imageBase64),
      mimeType: normalizeMimeType(input.mimeType)
    };
  }

  throw new Error("Provide either screenshotPath or imageBase64.");
}

async function analyzeWithClaudeAgentSdk(
  imageBase64: string,
  mimeType: ImageMimeType,
  prompt: string,
  modelConfig: AgentModelConfig,
  options: { model?: string; maxTurns: number; timeoutMs: number; claudeCodeExecutable?: string }
): Promise<{ text: string; result?: SDKResultMessage }> {
  const messages: string[] = [];
  let finalResult: SDKResultMessage | undefined;
  const settingsOption = modelConfig.settingsExists ? modelConfig.settingsPath : undefined;
  const run = query({
    prompt: screenshotPrompt(imageBase64, mimeType, prompt),
    options: {
      cwd: process.cwd(),
      maxTurns: options.maxTurns,
      model: options.model ?? modelConfig.model,
      fallbackModel: modelConfig.fallbackModel,
      pathToClaudeCodeExecutable: options.claudeCodeExecutable,
      settings: settingsOption,
      settingSources: ["user", "project", "local"],
      tools: [],
      permissionMode: "dontAsk",
      systemPrompt: [
        "You are a precise visual QA assistant for browser screenshots.",
        "Analyze only the screenshot and the user's requested verification question.",
        "Do not ask to run tools or inspect files. Return a concise visual judgment with pass/fail/blocker signals."
      ].join("\n"),
      env: {
        ...process.env,
        CLAUDE_AGENT_SDK_CLIENT_APP: "browser-vision-analyzer/0.1.0"
      },
      title: "Browser screenshot analysis"
    }
  });

  const timeout = setTimeout(() => run.close(), options.timeoutMs);
  try {
    for await (const message of run) {
      const text = messageToText(message);
      if (text) messages.push(text);
      if (message.type === "result") finalResult = message;
    }
  } finally {
    clearTimeout(timeout);
  }

  const text =
    finalResult?.type === "result" && finalResult.subtype === "success" ? finalResult.result.trim() : messages.join("\n").trim();
  if (!text) {
    throw new Error("Claude Agent SDK vision analysis did not return text.");
  }
  return { text, result: finalResult };
}

async function* screenshotPrompt(imageBase64: string, mimeType: ImageMimeType, prompt: string): AsyncIterable<SDKUserMessage> {
  yield {
    type: "user",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: mimeType,
            data: imageBase64
          }
        },
        {
          type: "text",
          text: prompt
        }
      ]
    }
  };
}

function messageToText(message: SDKMessage): string {
  if (message.type === "result" && message.subtype === "success") return message.result;
  if (message.type !== "assistant") return "";
  return message.message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter(Boolean)
    .join("\n");
}

function stripDataUrl(value: string): string {
  return value.replace(/^data:[^;]+;base64,/, "");
}

function inferMimeType(filePath: string, fallback: string): ImageMimeType {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".png") return "image/png";
  return normalizeMimeType(fallback);
}

function normalizeMimeType(value: string): ImageMimeType {
  if (value === "image/jpeg" || value === "image/png" || value === "image/gif" || value === "image/webp") return value;
  throw new Error(`Unsupported screenshot MIME type: ${value}. Use image/png, image/jpeg, image/gif, or image/webp.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
