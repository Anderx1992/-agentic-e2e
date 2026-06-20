import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(path.dirname(scriptPath), "..");
const serverEntry = process.argv[2] || "src/mcp/server.ts";
const tsx = path.join(pluginRoot, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");

if (!fs.existsSync(tsx)) {
  console.error(
    [
      "Development MCP launcher requires local dev dependencies.",
      "Install dev dependencies for source development, or run `npm run build` and use dist/mcp/*.mjs for plugin usage."
    ].join("\n")
  );
  process.exit(1);
}

const child = spawn(tsx, [path.resolve(pluginRoot, serverEntry)], {
  cwd: process.env.CLAUDE_PROJECT_DIR || pluginRoot,
  stdio: "inherit",
  env: process.env
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
