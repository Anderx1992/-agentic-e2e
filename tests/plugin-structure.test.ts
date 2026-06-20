import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(".");

test("Claude Code plugin manifest is present and valid", () => {
  const manifestPath = path.join(root, ".claude-plugin", "plugin.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    name?: string;
    description?: string;
    version?: string;
  };

  assert.equal(manifest.name, "browser-change-verifier");
  assert.match(manifest.description ?? "", /Chrome DevTools Protocol/);
  assert.match(manifest.version ?? "", /^\d+\.\d+\.\d+$/);
});

test("plugin declares a stdio MCP server", () => {
  const configPath = path.join(root, ".mcp.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
    mcpServers?: Record<string, { command?: string; args?: string[] }>;
  };
  const browserServer = config.mcpServers?.["browser-change-verifier"];
  const visionServer = config.mcpServers?.["browser-vision-analyzer"];
  const agentServer = config.mcpServers?.["browser-change-agent"];

  assert.equal(browserServer?.command, "node");
  assert.deepEqual(browserServer?.args, ["${CLAUDE_PLUGIN_ROOT}/scripts/start-mcp.mjs"]);
  assert.equal(visionServer?.command, "node");
  assert.deepEqual(visionServer?.args, ["${CLAUDE_PLUGIN_ROOT}/scripts/start-mcp.mjs", "src/mcp/vision-server.ts"]);
  assert.equal(agentServer?.command, "node");
  assert.deepEqual(agentServer?.args, ["${CLAUDE_PLUGIN_ROOT}/scripts/start-mcp.mjs", "src/mcp/agent-server.ts"]);
});

test("browser verification skill is namespaced by the plugin", () => {
  const skillPath = path.join(root, "skills", "verify-browser-change", "SKILL.md");
  const skill = fs.readFileSync(skillPath, "utf8");

  assert.match(skill, /^---\n/);
  assert.match(skill, /description: Verify frontend code changes/);
  assert.match(skill, /mcp__browser-change-verifier__browser_start/);
  assert.match(skill, /mcp__browser-vision-analyzer__analyze_screenshot/);
  assert.match(skill, /mcp__browser-change-agent__verify_change/);
});
