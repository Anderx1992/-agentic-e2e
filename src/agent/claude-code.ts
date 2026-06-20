import fs from "node:fs";
import path from "node:path";

const ENV_PATH_KEYS = ["CLAUDE_CODE_PATH", "CLAUDE_PATH"];
const WINDOWS_COMMANDS = ["claude.cmd", "claude.exe", "claude"];
const POSIX_COMMANDS = ["claude"];
const DARWIN_FALLBACK_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];

export function resolveClaudeCodeExecutable(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string | undefined {
  for (const key of ENV_PATH_KEYS) {
    const value = cleanEnvPath(env[key]);
    if (value && isFile(value)) return path.resolve(value);
  }

  const commands = platform === "win32" ? WINDOWS_COMMANDS : POSIX_COMMANDS;
  for (const dir of candidateDirectories(env, platform)) {
    if (!dir) continue;
    for (const command of commands) {
      const candidate = path.join(dir, command);
      if (isFile(candidate)) return candidate;
    }
  }

  return undefined;
}

function candidateDirectories(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const delimiter = platform === "win32" ? ";" : ":";
  const fromPath = pathValue(env)
    .split(delimiter)
    .map(cleanEnvPath)
    .filter((value): value is string => Boolean(value));
  const fallbackDirs = platform === "win32" ? windowsFallbackDirs(env) : platform === "darwin" ? DARWIN_FALLBACK_DIRS : [];
  return [...new Set([...fromPath, ...fallbackDirs])];
}

function pathValue(env: NodeJS.ProcessEnv): string {
  return env.PATH ?? env.Path ?? env.path ?? "";
}

function windowsFallbackDirs(env: NodeJS.ProcessEnv): string[] {
  return [
    ...npmPrefixDirs(env),
    env.APPDATA ? path.join(env.APPDATA, "npm") : undefined,
    env.USERPROFILE ? path.join(env.USERPROFILE, "AppData", "Roaming", "npm") : undefined,
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "Programs", "claude") : undefined,
    env.ProgramFiles ? path.join(env.ProgramFiles, "Claude") : undefined,
    env["ProgramFiles(x86)"] ? path.join(env["ProgramFiles(x86)"], "Claude") : undefined
  ].filter((value): value is string => Boolean(value));
}

function npmPrefixDirs(env: NodeJS.ProcessEnv): Array<string | undefined> {
  const prefixes = [env.NPM_CONFIG_PREFIX, env.npm_config_prefix, env.PREFIX].map(cleanEnvPath).filter(Boolean);
  return prefixes.flatMap((prefix) => {
    if (!prefix) return [];
    return [prefix, path.join(prefix, "bin")];
  });
}

function cleanEnvPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/^"(.*)"$/, "$1");
}

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}
