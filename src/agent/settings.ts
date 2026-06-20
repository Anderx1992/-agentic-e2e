import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveSettings, type Settings } from "@anthropic-ai/claude-agent-sdk";

export type AgentModelConfig = {
  settingsPath: string;
  settingsExists: boolean;
  model?: string;
  fallbackModel?: string;
  effort?: unknown;
  source: "user-settings" | "resolved-settings" | "environment" | "sdk-default";
  rawUserSettings?: Settings;
};

export async function loadAgentModelConfig(cwd: string): Promise<AgentModelConfig> {
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
  const rawUserSettings = readUserSettings(settingsPath);
  if (rawUserSettings?.model || rawUserSettings?.fallbackModel || rawUserSettings?.effort) {
    return {
      settingsPath,
      settingsExists: true,
      model: rawUserSettings.model,
      fallbackModel: normalizeFallbackModel(rawUserSettings.fallbackModel),
      effort: rawUserSettings.effort,
      source: "user-settings",
      rawUserSettings
    };
  }

  const resolved = await resolveSettings({
    cwd,
    settingSources: ["user"]
  }).catch(() => undefined);
  if (resolved?.effective.model || resolved?.effective.fallbackModel || resolved?.effective.effort) {
    return {
      settingsPath,
      settingsExists: fs.existsSync(settingsPath),
      model: resolved.effective.model,
      fallbackModel: normalizeFallbackModel(resolved.effective.fallbackModel),
      effort: resolved.effective.effort,
      source: "resolved-settings",
      rawUserSettings
    };
  }

  if (process.env.CLAUDE_MODEL) {
    return {
      settingsPath,
      settingsExists: fs.existsSync(settingsPath),
      model: process.env.CLAUDE_MODEL,
      source: "environment",
      rawUserSettings
    };
  }

  return {
    settingsPath,
    settingsExists: fs.existsSync(settingsPath),
    source: "sdk-default",
    rawUserSettings
  };
}

function readUserSettings(settingsPath: string): Settings | undefined {
  if (!fs.existsSync(settingsPath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Settings;
  } catch (error) {
    throw new Error(`Unable to parse Claude settings at ${settingsPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function normalizeFallbackModel(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(",") : value;
}
