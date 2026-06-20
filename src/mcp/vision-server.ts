import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

type Provider = "anthropic" | "openai" | "openai-compatible";

type VisionAnalysis = {
  provider: Provider;
  model: string;
  analysis: string;
  image: {
    source: "path" | "base64";
    mimeType: string;
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
    title: "Analyze Screenshot With Vision Model",
    description: "Analyze a browser screenshot with a configured vision model. Accepts a screenshot path or base64 image.",
    inputSchema: {
      screenshotPath: z.string().optional().describe("Path to a screenshot file, usually from browser_observe.screenshotPath."),
      imageBase64: z.string().optional().describe("Base64 image data. Used when screenshotPath is not provided."),
      mimeType: z.string().optional().describe("Image MIME type. Defaults to image/png."),
      prompt: z.string().optional().describe("Specific visual verification question or expected behavior."),
      provider: z.enum(["auto", "anthropic", "openai", "openai-compatible"]).optional().describe("Model provider. Defaults to auto."),
      model: z.string().optional().describe("Model name. Defaults to VISION_MODEL or a provider-specific default."),
      maxTokens: z.number().min(1).max(4096).optional().describe("Max response tokens. Defaults to 1000.")
    }
  },
  async ({ screenshotPath, imageBase64, mimeType = "image/png", prompt, provider = "auto", model, maxTokens = 1000 }) => {
    const image = readImage({ screenshotPath, imageBase64, mimeType });
    const selected = selectProvider(provider, model);
    const analysis =
      selected.provider === "anthropic"
        ? await analyzeWithAnthropic(image.base64, image.mimeType, prompt ?? DEFAULT_PROMPT, selected.model, maxTokens)
        : await analyzeWithOpenAICompatible(selected.provider, image.base64, image.mimeType, prompt ?? DEFAULT_PROMPT, selected.model, maxTokens);

    const result: VisionAnalysis = {
      provider: selected.provider,
      model: selected.model,
      analysis,
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

function readImage(input: { screenshotPath?: string; imageBase64?: string; mimeType: string }): { base64: string; mimeType: string } {
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
      mimeType: input.mimeType
    };
  }

  throw new Error("Provide either screenshotPath or imageBase64.");
}

function selectProvider(requested: "auto" | Provider, model?: string): { provider: Provider; model: string } {
  if (requested === "anthropic" || (requested === "auto" && process.env.ANTHROPIC_API_KEY)) {
    return {
      provider: "anthropic",
      model: model ?? process.env.VISION_MODEL ?? "claude-sonnet-4-5"
    };
  }

  if (requested === "openai" || (requested === "auto" && process.env.OPENAI_API_KEY)) {
    return {
      provider: "openai",
      model: model ?? process.env.VISION_MODEL ?? "gpt-4o"
    };
  }

  if (requested === "openai-compatible" || (requested === "auto" && process.env.VISION_API_URL)) {
    const selectedModel = model ?? process.env.VISION_MODEL;
    if (!selectedModel) {
      throw new Error("Set VISION_MODEL or pass model when using openai-compatible provider.");
    }
    return {
      provider: "openai-compatible",
      model: selectedModel
    };
  }

  throw new Error(
    "No vision model provider configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or VISION_API_URL/VISION_API_KEY/VISION_MODEL."
  );
}

async function analyzeWithAnthropic(
  imageBase64: string,
  mimeType: string,
  prompt: string,
  model: string,
  maxTokens: number
): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required for anthropic provider.");

  const response = await fetch(process.env.ANTHROPIC_API_URL ?? "https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": process.env.ANTHROPIC_VERSION ?? "2023-06-01"
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [
        {
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
      ]
    })
  });

  const json = (await response.json().catch(() => undefined)) as
    | { content?: Array<{ type?: string; text?: string }>; error?: { message?: string } }
    | undefined;
  if (!response.ok) {
    throw new Error(`Anthropic vision request failed (${response.status}): ${json?.error?.message ?? response.statusText}`);
  }

  const text = json?.content?.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n").trim();
  if (!text) throw new Error("Anthropic vision response did not include text content.");
  return text;
}

async function analyzeWithOpenAICompatible(
  provider: "openai" | "openai-compatible",
  imageBase64: string,
  mimeType: string,
  prompt: string,
  model: string,
  maxTokens: number
): Promise<string> {
  const apiKey = provider === "openai" ? process.env.OPENAI_API_KEY : process.env.VISION_API_KEY;
  const url =
    provider === "openai"
      ? (process.env.OPENAI_API_URL ?? "https://api.openai.com/v1/chat/completions")
      : normalizeChatCompletionsUrl(process.env.VISION_API_URL);
  if (!apiKey) {
    throw new Error(`${provider === "openai" ? "OPENAI_API_KEY" : "VISION_API_KEY"} is required for ${provider} provider.`);
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: prompt
            },
            {
              type: "image_url",
              image_url: {
                url: `data:${mimeType};base64,${imageBase64}`
              }
            }
          ]
        }
      ]
    })
  });

  const json = (await response.json().catch(() => undefined)) as
    | { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } }
    | undefined;
  if (!response.ok) {
    throw new Error(`${provider} vision request failed (${response.status}): ${json?.error?.message ?? response.statusText}`);
  }

  const text = json?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error(`${provider} vision response did not include message content.`);
  return text;
}

function normalizeChatCompletionsUrl(url: string | undefined): string {
  if (!url) throw new Error("VISION_API_URL is required for openai-compatible provider.");
  return url.endsWith("/chat/completions") ? url : `${url.replace(/\/$/, "")}/chat/completions`;
}

function stripDataUrl(value: string): string {
  return value.replace(/^data:[^;]+;base64,/, "");
}

function inferMimeType(filePath: string, fallback: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".png") return "image/png";
  return fallback;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
