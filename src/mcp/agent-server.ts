import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
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

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("browser-change-agent MCP server running on stdio");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
