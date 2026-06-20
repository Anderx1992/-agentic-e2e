import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveClaudeCodeExecutable } from "../src/agent/claude-code.js";

test("Claude Code executable resolution prefers explicit local path", () => {
  const previousClaudeCodePath = process.env.CLAUDE_CODE_PATH;
  const previousClaudePath = process.env.CLAUDE_PATH;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-e2e-claude-"));
  const executable = path.join(tempDir, process.platform === "win32" ? "claude.cmd" : "claude");
  fs.writeFileSync(executable, "");

  try {
    process.env.CLAUDE_CODE_PATH = executable;
    delete process.env.CLAUDE_PATH;
    assert.equal(resolveClaudeCodeExecutable(), path.resolve(executable));
  } finally {
    restoreEnv("CLAUDE_CODE_PATH", previousClaudeCodePath);
    restoreEnv("CLAUDE_PATH", previousClaudePath);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Claude Code executable resolution finds local claude on PATH", () => {
  const previousClaudeCodePath = process.env.CLAUDE_CODE_PATH;
  const previousClaudePath = process.env.CLAUDE_PATH;
  const previousPath = process.env.PATH;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-e2e-claude-path-"));
  const executable = path.join(tempDir, process.platform === "win32" ? "claude.cmd" : "claude");
  fs.writeFileSync(executable, "");

  try {
    delete process.env.CLAUDE_CODE_PATH;
    delete process.env.CLAUDE_PATH;
    process.env.PATH = [tempDir, previousPath ?? ""].filter(Boolean).join(path.delimiter);
    assert.equal(resolveClaudeCodeExecutable(), executable);
  } finally {
    restoreEnv("CLAUDE_CODE_PATH", previousClaudeCodePath);
    restoreEnv("CLAUDE_PATH", previousClaudePath);
    restoreEnv("PATH", previousPath);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Claude Code executable resolution supports Windows Path casing and separators", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-e2e-claude-win-path-"));
  const executable = path.join(tempDir, "claude.cmd");
  fs.writeFileSync(executable, "");

  try {
    assert.equal(
      resolveClaudeCodeExecutable(
        {
          Path: [tempDir, "C:\\Other\\Bin"].join(";")
        },
        "win32"
      ),
      executable
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Claude Code executable resolution finds npm global install from Windows npm prefix", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-e2e-claude-npm-prefix-"));
  const executable = path.join(tempDir, "claude.cmd");
  fs.writeFileSync(executable, "");

  try {
    assert.equal(resolveClaudeCodeExecutable({ NPM_CONFIG_PREFIX: tempDir }, "win32"), executable);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Claude Code executable resolution finds default Windows npm global bin under USERPROFILE", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-e2e-claude-userprofile-"));
  const npmBin = path.join(tempDir, "AppData", "Roaming", "npm");
  const executable = path.join(npmBin, "claude.cmd");
  fs.mkdirSync(npmBin, { recursive: true });
  fs.writeFileSync(executable, "");

  try {
    assert.equal(resolveClaudeCodeExecutable({ USERPROFILE: tempDir }, "win32"), executable);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Claude Code executable resolution supports macOS PATH separators", () => {
  const tempDir = ".tmp-claude-darwin-bin";
  const executable = path.join(tempDir, "claude");
  fs.mkdirSync(tempDir, { recursive: true });
  fs.writeFileSync(executable, "");

  try {
    assert.equal(
      resolveClaudeCodeExecutable(
        {
          PATH: [".tmp-empty-bin", tempDir].join(":")
        },
        "darwin"
      ),
      executable
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Claude Code executable resolution accepts quoted explicit paths", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-e2e-claude-quoted-"));
  const executable = path.join(tempDir, process.platform === "win32" ? "claude.cmd" : "claude");
  fs.writeFileSync(executable, "");

  try {
    assert.equal(resolveClaudeCodeExecutable({ CLAUDE_CODE_PATH: `"${executable}"` }, process.platform), path.resolve(executable));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
