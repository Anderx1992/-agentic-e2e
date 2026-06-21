import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { markAgentEditForAutoVerify, runAutoVerifyStopHook } from "../agent/auto-verify-hook.js";
import { runBrowserChangeAgent } from "../agent/verify-agent.js";

const server = new McpServer({
  name: "browser-change-agent",
  version: "0.1.0"
});

server.registerTool(
  "verify_change",
  {
    title: "Verify Code Change In Browser",
    description:
      "Run the Claude Agent SDK browser-verification agent. It reads ~/.claude/settings.json for model config, inspects the code diff, operates Chrome via CDP, and uses screenshot-first visual analysis.",
    inputSchema: {
      instruction: z.string().optional().describe("Additional verification instruction or expected behavior."),
      appUrl: z.string().url().optional().describe("Known app URL to open, such as http://localhost:3000."),
      startCommand: z.string().optional().describe("Optional command to start the app, such as npm run dev."),
      headless: z.boolean().optional().describe("Run Chrome headless. Defaults to true."),
      artifactDir: z.string().optional().describe("Screenshot artifact directory. Defaults to artifacts/browser-change-verifier."),
      maxTurns: z.number().int().min(1).max(100).optional().describe("Max Agent SDK turns. Defaults to 30."),
      timeoutMs: z.number().int().min(1000).max(3_600_000).optional().describe("Wall-clock timeout. Defaults to 10 minutes."),
      permissionMode: z.enum(["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"]).optional()
    }
  },
  async (input) => {
    const result = await runBrowserChangeAgent(input);
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

server.registerTool(
  "mark_agent_edit",
  {
    title: "Mark Agent Code Edit For Auto Verification",
    description:
      "Claude Code PostToolUse hook entrypoint. Marks that the agent wrote code this turn so the Stop hook can run browser self-verification once coding settles.",
    inputSchema: {
      cwd: z.string().optional().describe("Project working directory from the PostToolUse hook."),
      hookEventName: z.string().optional().describe("Hook event name, normally PostToolUse."),
      toolName: z.string().optional().describe("Tool name that just ran, such as Write, Edit, or MultiEdit."),
      toolInput: z.unknown().optional().describe("Original tool input from Claude Code, when available.")
    }
  },
  async (input) => {
    const result = await markAgentEditForAutoVerify(input);
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

server.registerTool(
  "auto_verify_stop",
  {
    title: "Auto Verify Frontend Diff On Stop",
    description:
      "Claude Code Stop-hook entrypoint. Detects frontend-relevant git changes, runs browser verification once per diff fingerprint, and feeds the result back to Claude before it finishes.",
    inputSchema: {
      cwd: z.string().optional().describe("Project working directory from the Stop hook."),
      hookEventName: z.string().optional().describe("Hook event name, normally Stop."),
      stopHookActive: z.union([z.boolean(), z.string()]).optional().describe("Stop hook recursion guard from Claude Code."),
      transcriptPath: z.string().optional().describe("Claude Code transcript path."),
      lastAssistantMessage: z.string().optional().describe("Last assistant message from the Stop hook.")
    }
  },
  async (input) => {
    const result = await runAutoVerifyStopHook(input);
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
  console.error("browser-change-agent MCP server running on stdio");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
