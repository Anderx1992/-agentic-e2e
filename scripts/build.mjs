import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rolldown } from "rolldown";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(root, "dist");

const entries = {
  "mcp/server": path.join(root, "src", "mcp", "server.ts"),
  "mcp/vision-server": path.join(root, "src", "mcp", "vision-server.ts"),
  "mcp/agent-server": path.join(root, "src", "mcp", "agent-server.ts")
};

await fs.rm(distDir, { recursive: true, force: true });

const bundle = await rolldown({
  cwd: root,
  input: entries,
  platform: "node",
  treeshake: true
});

await bundle.write({
  dir: distDir,
  format: "esm",
  entryFileNames: "[name].mjs",
  chunkFileNames: "chunks/[name]-[hash].mjs",
  sourcemap: false
});

await bundle.close();

const files = await fs.readdir(path.join(distDir, "mcp"));
console.log(`Built ${files.length} MCP bundles into ${path.relative(root, path.join(distDir, "mcp"))}`);
