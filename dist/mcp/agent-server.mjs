import { a as number, c as unknown, i as boolean, n as McpServer, o as string, r as _enum, s as union, t as StdioServerTransport } from "../chunks/stdio-23NXtY0_.mjs";
import { n as resolveClaudeCodeExecutable, r as VCe, t as loadAgentModelConfig } from "../chunks/settings-DPrlj53b.mjs";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import os from "node:os";
import crypto from "node:crypto";
import fs$1 from "node:fs/promises";
import { promisify } from "node:util";
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
		skillInstructions: loadBrowserVerificationSkill(),
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
			"Inspect git status --short --untracked-files=all, git diff/stat, staged diff/stat, and relevant files before opening the browser.",
			"Include untracked changed files when inferring the affected scenario.",
			"Before opening the browser, produce a verification intent with changed files, inferred route/page, behavior under test, user flow, expected visible evidence, and fallback surface.",
			"Do not verify only the app shell, landing page, or homepage unless the diff points there or no narrower changed surface can be found.",
			"If startCommand is provided, use it. Otherwise infer the app dev or preview command from project files.",
			"If appUrl is provided, use it. Otherwise infer or discover the local URL from the running app.",
			"Call browser_start before browser tools. Use the requested headless value.",
			"Use browser_observe before visible actions.",
			"Prioritize screenshot-based visual analysis.",
			"For visual changes or ambiguous screenshots, call analyze_screenshot with screenshotPath and a focused prompt.",
			"Use ariaNodes refs for clicks/typing after visual target identification.",
			"Report changed files considered, inferred route/page, behavior under test, actions, screenshot evidence, vision-model findings when used, console errors, failed requests, blockers, assumptions, and final pass/fail/blocked judgment.",
			"Close the browser unless keeping it open is necessary to explain a blocker."
		],
		scenarioInference: [
			"Route/page file changes map through framework route conventions and router configuration.",
			"Component-only changes require finding an importer, story, parent route, or preview that renders the component.",
			"Form changes require exercising input, validation, submission state, and success or error messaging.",
			"Navigation changes require verifying the affected deep link or adjacent navigation behavior.",
			"Data-fetching changes require checking loading, success, empty, or error-adjacent UI when practical.",
			"Styling changes require screenshot evidence of the changed visual state."
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
function loadBrowserVerificationSkill() {
	const skillPath = path.join(pluginRoot, "skills", "verify-browser-change", "SKILL.md");
	return fs.readFileSync(skillPath, "utf8");
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
//#region src/agent/auto-verify-hook.ts
const execFileAsync = promisify(execFile);
const FRONTEND_EXTENSIONS = /* @__PURE__ */ new Set([
	".astro",
	".css",
	".html",
	".js",
	".jsx",
	".less",
	".mjs",
	".scss",
	".svelte",
	".ts",
	".tsx",
	".vue"
]);
const FRONTEND_PATH_HINTS = [
	"app/",
	"components/",
	"pages/",
	"public/",
	"routes/",
	"src/",
	"static/",
	"stories/",
	"styles/",
	"ui/",
	"views/"
];
const FRONTEND_CONFIG_FILES = /* @__PURE__ */ new Set([
	"angular.json",
	"astro.config.js",
	"astro.config.mjs",
	"astro.config.ts",
	"index.html",
	"jsconfig.json",
	"next.config.js",
	"next.config.mjs",
	"next.config.ts",
	"package.json",
	"package-lock.json",
	"pnpm-lock.yaml",
	"postcss.config.js",
	"postcss.config.mjs",
	"postcss.config.ts",
	"remix.config.js",
	"remix.config.ts",
	"svelte.config.js",
	"svelte.config.ts",
	"tailwind.config.js",
	"tailwind.config.mjs",
	"tailwind.config.ts",
	"tsconfig.json",
	"vite.config.js",
	"vite.config.mjs",
	"vite.config.ts",
	"webpack.config.js",
	"webpack.config.ts",
	"yarn.lock"
]);
async function markAgentEditForAutoVerify(input) {
	if (process.env.BROWSER_CHANGE_VERIFIER_AUTO_VERIFY === "0") return {};
	const cwd = path.resolve(input.cwd || process.cwd());
	const markerPath = await agentEditMarkerPath(cwd);
	await fs$1.writeFile(markerPath, JSON.stringify({
		cwd,
		markedAt: (/* @__PURE__ */ new Date()).toISOString(),
		hookEventName: input.hookEventName,
		toolName: input.toolName
	}, null, 2), "utf8").catch(() => void 0);
	return {};
}
async function runAutoVerifyStopHook(input) {
	if (process.env.BROWSER_CHANGE_VERIFIER_AUTO_VERIFY === "0") return {};
	const cwd = path.resolve(input.cwd || process.cwd());
	const editMarkerPath = await agentEditMarkerPath(cwd);
	if (!await readAgentEditMarker(editMarkerPath) && process.env.BROWSER_CHANGE_VERIFIER_VERIFY_EXISTING_DIFF !== "1") return {};
	const snapshot = await collectChangeSnapshot(cwd).catch(() => void 0);
	if (!snapshot || snapshot.frontendFiles.length === 0) {
		await removeMarker(editMarkerPath);
		return {};
	}
	const markerPath = await verificationMarkerPath(cwd);
	if ((await readMarker(markerPath))?.fingerprint === snapshot.fingerprint) {
		await removeMarker(editMarkerPath);
		return {};
	}
	const result = await runBrowserChangeAgent({
		instruction: [
			"Auto-verify the frontend diff before Claude Code finishes this coding turn.",
			"Detected change snapshot:",
			formatSnapshotForPrompt(snapshot),
			"Start by inspecting git status --short --untracked-files=all, git diff --stat, git diff --cached --stat, and targeted diffs.",
			"Include untracked frontend files in the reasoning.",
			"Before opening the browser, write a verification intent with changed files, inferred route/page, behavior under test, user flow, expected visible evidence, and fallback surface.",
			"Infer the smallest meaningful browser scenario from the changed files; do not verify only the homepage unless the diff points there or no narrower changed surface can be found.",
			"Run browser-level verification with screenshot-first evidence.",
			"Return a concise pass/fail/blocked judgment with changed files considered, inferred route/page, behavior under test, actions, screenshot path, console errors, failed requests, and assumptions."
		].join(" "),
		artifactDir: "artifacts/browser-change-verifier/auto",
		timeoutMs: 10 * 6e4,
		maxTurns: 30
	}, cwd);
	await writeMarker(markerPath, {
		cwd,
		fingerprint: snapshot.fingerprint,
		verifiedAt: (/* @__PURE__ */ new Date()).toISOString(),
		summary: result.summary
	}).catch(() => void 0);
	await removeMarker(editMarkerPath);
	return { hookSpecificOutput: {
		hookEventName: "Stop",
		additionalContext: [
			"Browser Change Verifier auto-ran because this turn left frontend-relevant git changes.",
			"",
			`Changed frontend files: ${snapshot.frontendFiles.slice(0, 20).join(", ")}${snapshot.frontendFiles.length > 20 ? ", ..." : ""}`,
			"",
			"Verification result:",
			result.summary || "(No summary returned.)",
			"",
			"Act on this before finishing: if verification passed, report the route/actions/evidence succinctly. If it failed or was blocked, continue fixing the code and let the Stop hook re-run on the new diff."
		].join("\n")
	} };
}
function formatSnapshotForPrompt(snapshot) {
	return JSON.stringify({
		frontendFiles: snapshot.frontendFiles.slice(0, 50),
		allChangedFiles: snapshot.files.slice(0, 80),
		gitStatus: trimForPrompt(snapshot.status, 6e3),
		diffStat: trimForPrompt(snapshot.diffStat, 4e3),
		cachedDiffStat: trimForPrompt(snapshot.cachedDiffStat, 4e3)
	}, null, 2);
}
function trimForPrompt(value, maxLength) {
	if (value.length <= maxLength) return value;
	return `${value.slice(0, maxLength)}\n...truncated...`;
}
async function collectChangeSnapshot(cwd) {
	const [status, diffStat, cachedDiffStat, diff, cachedDiff, untrackedContents] = await Promise.all([
		git(cwd, [
			"status",
			"--short",
			"--untracked-files=all"
		]),
		git(cwd, ["diff", "--stat"]),
		git(cwd, [
			"diff",
			"--cached",
			"--stat"
		]),
		git(cwd, [
			"diff",
			"--",
			"."
		]),
		git(cwd, [
			"diff",
			"--cached",
			"--",
			"."
		]),
		hashUntrackedContents(cwd)
	]);
	if (!status.trim()) return void 0;
	const files = parseStatusFiles(status);
	return {
		cwd,
		status,
		diffStat,
		cachedDiffStat,
		files,
		frontendFiles: files.filter(isFrontendRelevantPath),
		fingerprint: crypto.createHash("sha256").update(JSON.stringify({
			status,
			diffStat,
			cachedDiffStat,
			diff,
			cachedDiff,
			untrackedContents
		})).digest("hex")
	};
}
async function git(cwd, args) {
	const { stdout } = await execFileAsync("git", args, {
		cwd,
		maxBuffer: 20 * 1024 * 1024,
		windowsHide: true
	});
	return stdout;
}
function parseStatusFiles(status) {
	return status.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean).flatMap((line) => {
		const raw = line.slice(3).trim();
		if (!raw) return [];
		return [raw.split(" -> ").at(-1) ?? raw];
	}).map(normalizeRepoPath);
}
async function hashUntrackedContents(cwd) {
	const files = (await git(cwd, [
		"ls-files",
		"--others",
		"--exclude-standard",
		"-z"
	]).catch(() => "")).split("\0").filter(Boolean);
	if (files.length === 0) return void 0;
	const hashes = [];
	for (const file of files) {
		if (!isFrontendRelevantPath(file)) continue;
		const absolute = path.resolve(cwd, file);
		const relative = path.relative(cwd, absolute);
		if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
		if (!(await fs$1.stat(absolute).catch(() => void 0))?.isFile()) continue;
		const content = await fs$1.readFile(absolute).catch(() => void 0);
		if (!content) continue;
		hashes.push({
			path: normalizeRepoPath(file),
			sha256: crypto.createHash("sha256").update(content).digest("hex")
		});
	}
	return hashes;
}
function isFrontendRelevantPath(filePath) {
	const normalized = normalizeRepoPath(filePath);
	const basename = path.posix.basename(normalized);
	const extension = path.posix.extname(normalized).toLowerCase();
	if (FRONTEND_CONFIG_FILES.has(basename)) return true;
	if (!FRONTEND_EXTENSIONS.has(extension)) return false;
	return FRONTEND_PATH_HINTS.some((hint) => normalized.startsWith(hint)) || normalized.includes("/components/");
}
function normalizeRepoPath(filePath) {
	return filePath.replace(/\\/g, "/").replace(/^"\s*/, "").replace(/\s*"$/, "");
}
async function verificationMarkerPath(cwd) {
	const base = process.env.CLAUDE_PLUGIN_DATA || path.join(os.tmpdir(), "browser-change-verifier");
	const key = crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	const dir = path.join(base, "auto-verify");
	await fs$1.mkdir(dir, { recursive: true });
	return path.join(dir, `${key}.json`);
}
async function agentEditMarkerPath(cwd) {
	const base = process.env.CLAUDE_PLUGIN_DATA || path.join(os.tmpdir(), "browser-change-verifier");
	const key = crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	const dir = path.join(base, "auto-verify");
	await fs$1.mkdir(dir, { recursive: true });
	return path.join(dir, `${key}.dirty.json`);
}
async function readMarker(markerPath) {
	const raw = await fs$1.readFile(markerPath, "utf8").catch(() => void 0);
	if (!raw) return void 0;
	return JSON.parse(raw);
}
async function readAgentEditMarker(markerPath) {
	const raw = await fs$1.readFile(markerPath, "utf8").catch(() => void 0);
	if (!raw) return void 0;
	return JSON.parse(raw);
}
async function writeMarker(markerPath, marker) {
	await fs$1.writeFile(markerPath, JSON.stringify(marker, null, 2), "utf8");
}
async function removeMarker(markerPath) {
	await fs$1.rm(markerPath, { force: true }).catch(() => void 0);
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
server.registerTool("mark_agent_edit", {
	title: "Mark Agent Code Edit For Auto Verification",
	description: "Claude Code PostToolUse hook entrypoint. Marks that the agent wrote code this turn so the Stop hook can run browser self-verification once coding settles.",
	inputSchema: {
		cwd: string().optional().describe("Project working directory from the PostToolUse hook."),
		hookEventName: string().optional().describe("Hook event name, normally PostToolUse."),
		toolName: string().optional().describe("Tool name that just ran, such as Write, Edit, or MultiEdit."),
		toolInput: unknown().optional().describe("Original tool input from Claude Code, when available.")
	}
}, async (input) => {
	const result = await markAgentEditForAutoVerify(input);
	return { content: [{
		type: "text",
		text: JSON.stringify(result, null, 2)
	}] };
});
server.registerTool("auto_verify_stop", {
	title: "Auto Verify Frontend Diff On Stop",
	description: "Claude Code Stop-hook entrypoint. Detects frontend-relevant git changes, runs browser verification once per diff fingerprint, and feeds the result back to Claude before it finishes.",
	inputSchema: {
		cwd: string().optional().describe("Project working directory from the Stop hook."),
		hookEventName: string().optional().describe("Hook event name, normally Stop."),
		stopHookActive: union([boolean(), string()]).optional().describe("Stop hook recursion guard from Claude Code."),
		transcriptPath: string().optional().describe("Claude Code transcript path."),
		lastAssistantMessage: string().optional().describe("Last assistant message from the Stop hook.")
	}
}, async (input) => {
	const result = await runAutoVerifyStopHook(input);
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
