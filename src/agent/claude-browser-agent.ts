import fs from "node:fs";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import type { AnyZodRawShape, InferShape } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { BrowserHarnessClient } from "../harness/browser-harness-client.js";
import type { PlaywrightObserver } from "../browser/playwright-observer.js";
import type { Observation } from "../browser/observation.js";
import type { AgentAction } from "./actions.js";
import type { NLTestCase } from "../types/test-case.js";
import type { CaseResult, CaseStatus, StepRecord } from "../types/result.js";

type FinalReport = {
  status: CaseStatus;
  summary: string;
  reason: string;
};

export class ClaudeBrowserAgent {
  constructor(
    private readonly deps: {
      harness: BrowserHarnessClient;
      observer: PlaywrightObserver;
      artifactsDir: string;
    }
  ) {}

  async runCase(testCase: NLTestCase): Promise<Omit<CaseResult, "startedAt" | "finishedAt" | "durationMs" | "artifactsDir">> {
    const steps: StepRecord[] = [];
    let lastObservation: Observation | undefined;
    let finalReport: FinalReport | undefined;

    const observe = tool(
      "observe_browser",
      "Observe the current browser page. Returns URL, title, visible text, console errors, failed requests, and a screenshot image.",
      {},
      async () => {
        lastObservation = await this.deps.observer.observe(this.deps.artifactsDir, steps.length + 1);
        const content: Array<Record<string, unknown>> = [
          {
            type: "text",
            text: JSON.stringify(
              {
                url: lastObservation.url,
                title: lastObservation.title,
                visibleText: lastObservation.visibleText,
                consoleErrors: lastObservation.consoleErrors.slice(-20),
                failedRequests: lastObservation.failedRequests.slice(-20),
                screenshotPath: lastObservation.screenshotPath
              },
              null,
              2
            )
          }
        ];

        if (lastObservation.screenshotPath && fs.existsSync(lastObservation.screenshotPath)) {
          content.push({
            type: "image",
            data: fs.readFileSync(lastObservation.screenshotPath).toString("base64"),
            mimeType: "image/png"
          });
        }

        return { content } as any;
      },
      { annotations: { readOnlyHint: true } }
    );

    const makeActionTool = <T extends AnyZodRawShape>(
      name: string,
      description: string,
      schema: T,
      toAction: (args: InferShape<T>) => AgentAction
    ) =>
      tool(name, description, schema, async (args) => {
        const action = toAction(args);
        const actionResult = await this.deps.harness.execute(action);
        const observation =
          lastObservation ?? (await this.deps.observer.observe(this.deps.artifactsDir, steps.length + 1));
        steps.push({
          index: steps.length + 1,
          observation,
          action,
          actionResult
        });
        lastObservation = undefined;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ok: true, action, actionResult }, null, 2)
            }
          ]
        } as any;
      });

    const click = makeActionTool(
      "click",
      "Click a visible point in the browser viewport. Use observe_browser first and choose coordinates from the screenshot.",
      {
        x: z.number().describe("Viewport x coordinate"),
        y: z.number().describe("Viewport y coordinate"),
        reason: z.string().describe("Why this click is the right next action")
      },
      ({ x, y, reason }) => ({ type: "click", x, y, reason })
    );

    const typeText = makeActionTool(
      "type_text",
      "Type text into the currently focused browser element.",
      {
        text: z.string(),
        reason: z.string()
      },
      ({ text, reason }) => ({ type: "type", text, reason })
    );

    const pressKey = makeActionTool(
      "press_key",
      "Press one keyboard key or shortcut, such as Enter, Tab, Escape, ArrowDown, Ctrl+A.",
      {
        key: z.string(),
        reason: z.string()
      },
      ({ key, reason }) => ({ type: "press", key, reason })
    );

    const scroll = makeActionTool(
      "scroll",
      "Scroll the current page by a deltaY amount. Positive values scroll down.",
      {
        deltaY: z.number(),
        reason: z.string()
      },
      ({ deltaY, reason }) => ({ type: "scroll", deltaY, reason })
    );

    const wait = makeActionTool(
      "wait",
      "Wait for the UI to settle.",
      {
        ms: z.number().min(0).max(10000),
        reason: z.string()
      },
      ({ ms, reason }) => ({ type: "wait", ms, reason })
    );

    const navigate = makeActionTool(
      "navigate",
      "Navigate by opening a new browser tab.",
      {
        url: z.string().url(),
        reason: z.string()
      },
      ({ url, reason }) => ({ type: "navigate", url, reason })
    );

    const runJs = makeActionTool(
      "run_js",
      "Run small JavaScript inspection code in the page. Prefer observe_browser and visible actions first.",
      {
        code: z.string(),
        reason: z.string()
      },
      ({ code, reason }) => ({ type: "js", code, reason })
    );

    const finishTest = tool(
      "finish_test",
      "Finish the natural-language browser test with the final judgment.",
      {
        status: z.enum(["pass", "fail", "blocked"]),
        summary: z.string(),
        reason: z.string()
      },
      async ({ status, summary, reason }) => {
        finalReport = { status, summary, reason };
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(finalReport, null, 2)
            }
          ]
        } as any;
      }
    );

    const server = createSdkMcpServer({
      name: "browser_agent",
      version: "0.1.0",
      tools: [observe, click, typeText, pressKey, scroll, wait, navigate, runJs, finishTest]
    });

    const allowedTools = [
      "mcp__browser_agent__observe_browser",
      "mcp__browser_agent__click",
      "mcp__browser_agent__type_text",
      "mcp__browser_agent__press_key",
      "mcp__browser_agent__scroll",
      "mcp__browser_agent__wait",
      "mcp__browser_agent__navigate",
      "mcp__browser_agent__run_js",
      "mcp__browser_agent__finish_test"
    ];

    const messages: string[] = [];
    const maxTurns = Math.max(10, (testCase.constraints?.max_steps ?? 25) * 4);

    for await (const message of query({
      prompt: buildPrompt(testCase),
      options: {
        model: process.env.CLAUDE_MODEL,
        maxTurns,
        permissionMode: "dontAsk",
        allowedTools,
        mcpServers: {
          browser_agent: server
        },
        systemPrompt: systemPrompt()
      }
    })) {
      messages.push(messageToText(message));
    }

    const finalObservation = await this.deps.observer.observe(this.deps.artifactsDir, steps.length + 1);
    const fallback = finalReport ?? parseFinalFromText(messages.join("\n"));

    return {
      case: testCase,
      status: fallback.status,
      summary: fallback.summary,
      reason: fallback.reason,
      steps,
      finalObservation
    };
  }
}

function systemPrompt(): string {
  return [
    "You are an agentic browser E2E tester.",
    "You must execute and evaluate natural-language browser test cases.",
    "Always call observe_browser before choosing a visible browser action.",
    "Use browser tools to interact with the page. Do not use built-in shell or file tools.",
    "Do not type passwords or secrets. If authentication is required and the browser is not already logged in, finish as blocked.",
    "Call finish_test exactly once when the success criteria pass, failure criteria trigger, or the task is blocked.",
    "Use Chinese for summary and reason."
  ].join("\n");
}

function buildPrompt(testCase: NLTestCase): string {
  return JSON.stringify(
    {
      instruction: "Run this natural-language browser test case end-to-end.",
      case: testCase,
      workflow: [
        "Open or use the provided start URL.",
        "Observe the browser.",
        "Take one browser action at a time.",
        "Re-observe after each meaningful action.",
        "Judge against success_criteria and failure_criteria.",
        "Call finish_test with pass, fail, or blocked."
      ]
    },
    null,
    2
  );
}

function messageToText(message: unknown): string {
  const value = message as {
    type?: string;
    result?: string;
    subtype?: string;
    message?: { content?: Array<{ type?: string; text?: string }> };
  };

  if (value.type === "result" && value.result) return value.result;
  if (value.type === "assistant" && value.message?.content) {
    return value.message.content.map((block) => (block.type === "text" ? block.text ?? "" : "")).join("\n");
  }
  return "";
}

function parseFinalFromText(text: string): FinalReport {
  const match = text.match(/\{[\s\S]*"status"\s*:\s*"(pass|fail|blocked)"[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as FinalReport;
      if (parsed.status && parsed.summary && parsed.reason) return parsed;
    } catch {
      // Fall through to a deterministic blocked result.
    }
  }

  return {
    status: "blocked",
    summary: "Agent did not call finish_test, so no reliable conclusion was produced.",
    reason: "The Claude Agent SDK session ended without a structured final judgment."
  };
}
