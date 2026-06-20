import { a as number, n as McpServer, o as string, t as StdioServerTransport } from "../chunks/stdio-lOD893kD.mjs";
import { n as resolveClaudeCodeExecutable, r as VCe, t as loadAgentModelConfig } from "../chunks/settings-DPrlj53b.mjs";
import fs from "node:fs";
import path from "node:path";
//#region src/mcp/vision-server.ts
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
server.registerTool("analyze_screenshot", {
	title: "Analyze Screenshot With Claude Agent SDK",
	description: "Analyze a browser screenshot through Claude Agent SDK. Accepts a screenshot path or base64 image.",
	inputSchema: {
		screenshotPath: string().optional().describe("Path to a screenshot file, usually from browser_observe.screenshotPath."),
		imageBase64: string().optional().describe("Base64 image data. Used when screenshotPath is not provided."),
		mimeType: string().optional().describe("Image MIME type. Defaults to image/png."),
		prompt: string().optional().describe("Specific visual verification question or expected behavior."),
		model: string().optional().describe("Optional SDK model override. Defaults to ~/.claude/settings.json, then CLAUDE_MODEL, then SDK default."),
		maxTurns: number().int().min(1).max(5).optional().describe("Maximum SDK agent turns. Defaults to 1."),
		timeoutMs: number().int().min(1e3).max(3e5).optional().describe("Timeout for the SDK analysis. Defaults to 120000.")
	}
}, async ({ screenshotPath, imageBase64, mimeType = "image/png", prompt, model, maxTurns = 1, timeoutMs = 12e4 }) => {
	const image = readImage({
		screenshotPath,
		imageBase64,
		mimeType
	});
	const modelConfig = await loadAgentModelConfig(process.cwd());
	const claudeCodeExecutable = resolveClaudeCodeExecutable();
	const analysis = await analyzeWithClaudeAgentSdk(image.base64, image.mimeType, prompt ?? DEFAULT_PROMPT, modelConfig, {
		model,
		maxTurns,
		timeoutMs,
		claudeCodeExecutable
	});
	const result = {
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
		stopReason: analysis.result?.type === "result" && analysis.result.subtype === "success" ? analysis.result.stop_reason : void 0,
		terminalReason: analysis.result?.type === "result" && analysis.result.subtype === "success" ? analysis.result.terminal_reason : void 0,
		totalCostUsd: analysis.result?.type === "result" && analysis.result.subtype === "success" ? analysis.result.total_cost_usd : void 0,
		image: {
			source: screenshotPath ? "path" : "base64",
			mimeType: image.mimeType,
			bytes: Buffer.byteLength(image.base64, "base64"),
			screenshotPath: screenshotPath ? path.resolve(screenshotPath) : void 0
		}
	};
	return { content: [{
		type: "text",
		text: JSON.stringify(result, null, 2)
	}] };
});
async function main() {
	const transport = new StdioServerTransport();
	await server.connect(transport);
	console.error("browser-vision-analyzer MCP server running on stdio");
}
function readImage(input) {
	if (input.screenshotPath) {
		const filePath = path.resolve(input.screenshotPath);
		if (!fs.existsSync(filePath)) throw new Error(`Screenshot does not exist: ${filePath}`);
		return {
			base64: fs.readFileSync(filePath).toString("base64"),
			mimeType: inferMimeType(filePath, input.mimeType)
		};
	}
	if (input.imageBase64) return {
		base64: stripDataUrl(input.imageBase64),
		mimeType: normalizeMimeType(input.mimeType)
	};
	throw new Error("Provide either screenshotPath or imageBase64.");
}
async function analyzeWithClaudeAgentSdk(imageBase64, mimeType, prompt, modelConfig, options) {
	const messages = [];
	let finalResult;
	const settingsOption = modelConfig.settingsExists ? modelConfig.settingsPath : void 0;
	const run = VCe({
		prompt: screenshotPrompt(imageBase64, mimeType, prompt),
		options: {
			cwd: process.cwd(),
			maxTurns: options.maxTurns,
			model: options.model ?? modelConfig.model,
			fallbackModel: modelConfig.fallbackModel,
			pathToClaudeCodeExecutable: options.claudeCodeExecutable,
			settings: settingsOption,
			settingSources: [
				"user",
				"project",
				"local"
			],
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
	const text = finalResult?.type === "result" && finalResult.subtype === "success" ? finalResult.result.trim() : messages.join("\n").trim();
	if (!text) throw new Error("Claude Agent SDK vision analysis did not return text.");
	return {
		text,
		result: finalResult
	};
}
async function* screenshotPrompt(imageBase64, mimeType, prompt) {
	yield {
		type: "user",
		parent_tool_use_id: null,
		message: {
			role: "user",
			content: [{
				type: "image",
				source: {
					type: "base64",
					media_type: mimeType,
					data: imageBase64
				}
			}, {
				type: "text",
				text: prompt
			}]
		}
	};
}
function messageToText(message) {
	if (message.type === "result" && message.subtype === "success") return message.result;
	if (message.type !== "assistant") return "";
	return message.message.content.map((block) => block.type === "text" ? block.text : "").filter(Boolean).join("\n");
}
function stripDataUrl(value) {
	return value.replace(/^data:[^;]+;base64,/, "");
}
function inferMimeType(filePath, fallback) {
	const ext = path.extname(filePath).toLowerCase();
	if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
	if (ext === ".webp") return "image/webp";
	if (ext === ".gif") return "image/gif";
	if (ext === ".png") return "image/png";
	return normalizeMimeType(fallback);
}
function normalizeMimeType(value) {
	if (value === "image/jpeg" || value === "image/png" || value === "image/gif" || value === "image/webp") return value;
	throw new Error(`Unsupported screenshot MIME type: ${value}. Use image/png, image/jpeg, image/gif, or image/webp.`);
}
main().catch((error) => {
	console.error(error);
	process.exit(1);
});
//#endregion
export {};
