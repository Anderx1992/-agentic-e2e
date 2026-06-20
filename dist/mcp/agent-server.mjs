import { a as number, i as boolean, n as McpServer, o as string, r as _enum, t as StdioServerTransport } from "../chunks/stdio-lOD893kD.mjs";
import { n as resolveClaudeCodeExecutable, r as VCe, t as loadAgentModelConfig } from "../chunks/settings-DPrlj53b.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
//#region src/agent/verify-agent.ts
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
async function runBrowserChangeAgent(input, cwd = process.cwd()) {
	const modelConfig = await loadAgentModelConfig(cwd);
	const messages = [];
	let finalResult;
	const settingsOption = modelConfig.settingsExists ? modelConfig.settingsPath : void 0;
	const claudeCodeExecutable = resolveClaudeCodeExecutable();
	const maxTurns = input.maxTurns ?? 30;
	const permissionMode = input.permissionMode ?? "dontAsk";
	const run = VCe({
		prompt: buildPrompt(input, modelConfig),
		options: {
			cwd,
			maxTurns,
			model: modelConfig.model,
			fallbackModel: modelConfig.fallbackModel,
			pathToClaudeCodeExecutable: claudeCodeExecutable,
			settings: settingsOption,
			settingSources: [
				"user",
				"project",
				"local"
			],
			tools: [
				"Read",
				"Grep",
				"Glob",
				"Bash"
			],
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
					timeout: 6e5,
					alwaysLoad: true
				},
				"browser-vision-analyzer": {
					type: "stdio",
					command: "node",
					args: mcpServerArgs("vision-server", "src/mcp/vision-server.ts"),
					timeout: 6e5,
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
	const timeout = setTimeout(() => run.close(), input.timeoutMs ?? 10 * 6e4);
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
		stopReason: finalResult?.type === "result" && finalResult.subtype === "success" ? finalResult.stop_reason : void 0,
		terminalReason: finalResult?.type === "result" && finalResult.subtype === "success" ? finalResult.terminal_reason : void 0,
		totalCostUsd: finalResult?.type === "result" && finalResult.subtype === "success" ? finalResult.total_cost_usd : void 0,
		messages: messages.slice(-20)
	};
}
function mcpServerArgs(bundleName, sourceEntry = "src/mcp/server.ts") {
	const bundled = path.join(pluginRoot, "dist", "mcp", `${bundleName}.mjs`);
	if (fs.existsSync(bundled)) return [bundled];
	return [path.join(pluginRoot, "scripts", "start-mcp.mjs"), sourceEntry];
}
function buildPrompt(input, modelConfig) {
	return JSON.stringify({
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
	}, null, 2);
}
function systemAppend() {
	return [
		"You are a browser change verification agent.",
		"Your job is to inspect code changes, infer a practical browser scenario, and verify the change in Chrome.",
		"Use screenshot-first visual analysis. DOM, aria, and JavaScript inspection are supporting tools, not the primary evidence for visible behavior.",
		"Do not edit files. Do not run destructive shell commands. Avoid commands that mutate git state.",
		"When using Bash, prefer read-only inspection commands and the project's normal dev/preview/test commands.",
		"Use Chinese for final summaries unless the user requested another language."
	].join("\n");
}
function messageToText(message) {
	if (message.type === "result" && message.subtype === "success") return message.result;
	if (message.type !== "assistant") return "";
	return message.message.content.map((block) => {
		if (block.type === "text") return block.text;
		if (block.type === "tool_use") return `[tool_use:${block.name}]`;
		return "";
	}).filter(Boolean).join("\n");
}
//#endregion
//#region src/mcp/agent-server.ts
const server = new McpServer({
	name: "browser-change-agent",
	version: "0.1.0"
});
server.registerTool("verify_change", {
	title: "Verify Code Change In Browser",
	description: "Run the Claude Agent SDK browser-verification agent. It reads ~/.claude/settings.json for model config, inspects the code diff, operates Chrome via CDP, and uses screenshot-first visual analysis.",
	inputSchema: {
		instruction: string().optional().describe("Additional verification instruction or expected behavior."),
		appUrl: string().url().optional().describe("Known app URL to open, such as http://localhost:3000."),
		startCommand: string().optional().describe("Optional command to start the app, such as npm run dev."),
		headless: boolean().optional().describe("Run Chrome headless. Defaults to true."),
		artifactDir: string().optional().describe("Screenshot artifact directory. Defaults to artifacts/browser-change-verifier."),
		maxTurns: number().int().min(1).max(100).optional().describe("Max Agent SDK turns. Defaults to 30."),
		timeoutMs: number().int().min(1e3).max(36e5).optional().describe("Wall-clock timeout. Defaults to 10 minutes."),
		permissionMode: _enum([
			"default",
			"acceptEdits",
			"bypassPermissions",
			"plan",
			"dontAsk",
			"auto"
		]).optional()
	}
}, async (input) => {
	const result = await runBrowserChangeAgent(input);
	return { content: [{
		type: "text",
		text: JSON.stringify(result, null, 2)
	}] };
});
async function main() {
	const transport = new StdioServerTransport();
	await server.connect(transport);
	console.error("browser-change-agent MCP server running on stdio");
}
main().catch((error) => {
	console.error(error);
	process.exit(1);
});
//#endregion
export {};
