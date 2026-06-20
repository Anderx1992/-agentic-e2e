import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(path.dirname(scriptPath), "..");
const pluginData = process.env.CLAUDE_PLUGIN_DATA || path.join(pluginRoot, ".plugin-data");
const serverEntry = process.argv[2] || "src/mcp/server.ts";
const packageJson = path.join(pluginRoot, "package.json");
const packageLock = path.join(pluginRoot, "package-lock.json");
const dataPackageJson = path.join(pluginData, "package.json");
const dataPackageLock = path.join(pluginData, "package-lock.json");

fs.mkdirSync(pluginData, { recursive: true });

if (needsInstall()) {
  fs.copyFileSync(packageJson, dataPackageJson);
  if (fs.existsSync(packageLock)) fs.copyFileSync(packageLock, dataPackageLock);

  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const install = spawnSync(npm, ["install", "--omit=optional"], {
    cwd: pluginData,
    stdio: "inherit",
    env: process.env
  });
  if (install.status !== 0) {
    fs.rmSync(dataPackageJson, { force: true });
    process.exit(install.status ?? 1);
  }
}

const tsx = path.join(pluginData, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
const child = spawn(tsx, [path.resolve(pluginRoot, serverEntry)], {
  cwd: process.env.CLAUDE_PROJECT_DIR || pluginRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_PATH: path.join(pluginData, "node_modules")
  }
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

function needsInstall() {
  if (!fs.existsSync(dataPackageJson)) return true;
  if (!fs.existsSync(path.join(pluginData, "node_modules"))) return true;
  return fs.readFileSync(packageJson, "utf8") !== fs.readFileSync(dataPackageJson, "utf8");
}
