import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { runBrowserChangeAgent } from "./verify-agent.js";

const execFileAsync = promisify(execFile);

export type StopHookInput = {
  cwd?: string;
  hookEventName?: string;
  stopHookActive?: boolean | string;
  transcriptPath?: string;
  lastAssistantMessage?: string;
};

export type AgentEditHookInput = {
  cwd?: string;
  hookEventName?: string;
  toolName?: string;
  toolInput?: unknown;
};

type HookOutput =
  | Record<string, never>
  | {
      hookSpecificOutput: {
        hookEventName: "Stop";
        additionalContext: string;
      };
    };

type ChangeSnapshot = {
  cwd: string;
  status: string;
  diffStat: string;
  cachedDiffStat: string;
  files: string[];
  frontendFiles: string[];
  fingerprint: string;
};

type VerificationMarker = {
  cwd: string;
  fingerprint: string;
  verifiedAt: string;
  summary: string;
};

type AgentEditMarker = {
  cwd: string;
  markedAt: string;
  hookEventName?: string;
  toolName?: string;
};

const FRONTEND_EXTENSIONS = new Set([
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

const FRONTEND_CONFIG_FILES = new Set([
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

export async function markAgentEditForAutoVerify(input: AgentEditHookInput): Promise<Record<string, never>> {
  if (process.env.BROWSER_CHANGE_VERIFIER_AUTO_VERIFY === "0") return {};

  const cwd = path.resolve(input.cwd || process.cwd());
  const markerPath = await agentEditMarkerPath(cwd);
  await fs
    .writeFile(
      markerPath,
      JSON.stringify(
        {
          cwd,
          markedAt: new Date().toISOString(),
          hookEventName: input.hookEventName,
          toolName: input.toolName
        } satisfies AgentEditMarker,
        null,
        2
      ),
      "utf8"
    )
    .catch(() => undefined);

  return {};
}

export async function runAutoVerifyStopHook(input: StopHookInput): Promise<HookOutput> {
  if (process.env.BROWSER_CHANGE_VERIFIER_AUTO_VERIFY === "0") return {};

  const cwd = path.resolve(input.cwd || process.cwd());
  const editMarkerPath = await agentEditMarkerPath(cwd);
  const editMarker = await readAgentEditMarker(editMarkerPath);
  if (!editMarker && process.env.BROWSER_CHANGE_VERIFIER_VERIFY_EXISTING_DIFF !== "1") return {};

  const snapshot = await collectChangeSnapshot(cwd).catch(() => undefined);
  if (!snapshot || snapshot.frontendFiles.length === 0) {
    await removeMarker(editMarkerPath);
    return {};
  }

  const markerPath = await verificationMarkerPath(cwd);
  const marker = await readMarker(markerPath);
  if (marker?.fingerprint === snapshot.fingerprint) {
    await removeMarker(editMarkerPath);
    return {};
  }

  const result = await runBrowserChangeAgent(
    {
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
      timeoutMs: 10 * 60_000,
      maxTurns: 30
    },
    cwd
  );

  await writeMarker(markerPath, {
    cwd,
    fingerprint: snapshot.fingerprint,
    verifiedAt: new Date().toISOString(),
    summary: result.summary
  }).catch(() => undefined);
  await removeMarker(editMarkerPath);

  return {
    hookSpecificOutput: {
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
    }
  };
}

function formatSnapshotForPrompt(snapshot: ChangeSnapshot): string {
  return JSON.stringify(
    {
      frontendFiles: snapshot.frontendFiles.slice(0, 50),
      allChangedFiles: snapshot.files.slice(0, 80),
      gitStatus: trimForPrompt(snapshot.status, 6000),
      diffStat: trimForPrompt(snapshot.diffStat, 4000),
      cachedDiffStat: trimForPrompt(snapshot.cachedDiffStat, 4000)
    },
    null,
    2
  );
}

function trimForPrompt(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n...truncated...`;
}

async function collectChangeSnapshot(cwd: string): Promise<ChangeSnapshot | undefined> {
  const [status, diffStat, cachedDiffStat, diff, cachedDiff, untrackedContents] = await Promise.all([
    git(cwd, ["status", "--short", "--untracked-files=all"]),
    git(cwd, ["diff", "--stat"]),
    git(cwd, ["diff", "--cached", "--stat"]),
    git(cwd, ["diff", "--", "."]),
    git(cwd, ["diff", "--cached", "--", "."]),
    hashUntrackedContents(cwd)
  ]);

  if (!status.trim()) return undefined;

  const files = parseStatusFiles(status);
  const frontendFiles = files.filter(isFrontendRelevantPath);
  const fingerprint = crypto
    .createHash("sha256")
    .update(JSON.stringify({ status, diffStat, cachedDiffStat, diff, cachedDiff, untrackedContents }))
    .digest("hex");

  return {
    cwd,
    status,
    diffStat,
    cachedDiffStat,
    files,
    frontendFiles,
    fingerprint
  };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true
  });
  return stdout;
}

function parseStatusFiles(status: string): string[] {
  return status
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .flatMap((line) => {
      const raw = line.slice(3).trim();
      if (!raw) return [];
      const renameParts = raw.split(" -> ");
      return [renameParts.at(-1) ?? raw];
    })
    .map(normalizeRepoPath);
}

async function hashUntrackedContents(cwd: string): Promise<Array<{ path: string; sha256: string }> | undefined> {
  const output = await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]).catch(() => "");
  const files = output.split("\0").filter(Boolean);
  if (files.length === 0) return undefined;

  const hashes: Array<{ path: string; sha256: string }> = [];
  for (const file of files) {
    if (!isFrontendRelevantPath(file)) continue;
    const absolute = path.resolve(cwd, file);
    const relative = path.relative(cwd, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    const stat = await fs.stat(absolute).catch(() => undefined);
    if (!stat?.isFile()) continue;
    const content = await fs.readFile(absolute).catch(() => undefined);
    if (!content) continue;
    hashes.push({
      path: normalizeRepoPath(file),
      sha256: crypto.createHash("sha256").update(content).digest("hex")
    });
  }
  return hashes;
}

function isFrontendRelevantPath(filePath: string): boolean {
  const normalized = normalizeRepoPath(filePath);
  const basename = path.posix.basename(normalized);
  const extension = path.posix.extname(normalized).toLowerCase();
  if (FRONTEND_CONFIG_FILES.has(basename)) return true;
  if (!FRONTEND_EXTENSIONS.has(extension)) return false;
  return FRONTEND_PATH_HINTS.some((hint) => normalized.startsWith(hint)) || normalized.includes("/components/");
}

function normalizeRepoPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^"\s*/, "").replace(/\s*"$/, "");
}

async function verificationMarkerPath(cwd: string): Promise<string> {
  const base = process.env.CLAUDE_PLUGIN_DATA || path.join(os.tmpdir(), "browser-change-verifier");
  const key = crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 16);
  const dir = path.join(base, "auto-verify");
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, `${key}.json`);
}

async function agentEditMarkerPath(cwd: string): Promise<string> {
  const base = process.env.CLAUDE_PLUGIN_DATA || path.join(os.tmpdir(), "browser-change-verifier");
  const key = crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 16);
  const dir = path.join(base, "auto-verify");
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, `${key}.dirty.json`);
}

async function readMarker(markerPath: string): Promise<VerificationMarker | undefined> {
  const raw = await fs.readFile(markerPath, "utf8").catch(() => undefined);
  if (!raw) return undefined;
  return JSON.parse(raw) as VerificationMarker;
}

async function readAgentEditMarker(markerPath: string): Promise<AgentEditMarker | undefined> {
  const raw = await fs.readFile(markerPath, "utf8").catch(() => undefined);
  if (!raw) return undefined;
  return JSON.parse(raw) as AgentEditMarker;
}

async function writeMarker(markerPath: string, marker: VerificationMarker): Promise<void> {
  await fs.writeFile(markerPath, JSON.stringify(marker, null, 2), "utf8");
}

async function removeMarker(markerPath: string): Promise<void> {
  await fs.rm(markerPath, { force: true }).catch(() => undefined);
}
