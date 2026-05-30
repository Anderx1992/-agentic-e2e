import fs from "node:fs";
import path from "node:path";
import { ClaudeBrowserAgent } from "../agent/claude-browser-agent.js";
import { startChrome } from "../browser/chrome-manager.js";
import { PlaywrightObserver } from "../browser/playwright-observer.js";
import { loadCase } from "../config/load-case.js";
import { BrowserHarnessClient } from "../harness/browser-harness-client.js";
import { writeReports } from "../report/reporter.js";
import type { CaseResult } from "../types/result.js";

export async function runCase(casePath: string): Promise<CaseResult> {
  const testCase = loadCase(casePath);
  const startedAt = new Date();
  const runId = `${sanitize(testCase.id)}-${startedAt.toISOString().replaceAll(":", "-").replaceAll(".", "-")}`;
  const artifactsDir = path.resolve("artifacts", "runs", runId);
  fs.mkdirSync(artifactsDir, { recursive: true });

  const chrome = await startChrome({
    headless: testCase.constraints?.headless ?? true
  });

  let observer: PlaywrightObserver | undefined;
  let harness: BrowserHarnessClient | undefined;

  try {
    observer = await PlaywrightObserver.connect(chrome.cdpUrl);
    harness = new BrowserHarnessClient({ cdpUrl: chrome.cdpUrl });
    await harness.newTab(testCase.app.start_url);

    const agent = new ClaudeBrowserAgent({
      harness,
      observer,
      artifactsDir
    });

    const timeoutMs = testCase.constraints?.timeout_ms ?? 120000;
    const core = await withTimeout(agent.runCase(testCase), timeoutMs);
    const finishedAt = new Date();

    const result: CaseResult = {
      ...core,
      artifactsDir,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime()
    };

    writeReports(result);
    return result;
  } catch (error) {
    const finishedAt = new Date();
    const result: CaseResult = {
      case: testCase,
      status: "blocked",
      summary: "用例执行被中断。",
      reason: error instanceof Error ? error.message : String(error),
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      steps: [],
      artifactsDir
    };
    writeReports(result);
    return result;
  } finally {
    await harness?.close();
    await observer?.close();
    await chrome.close();
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Case timed out after ${timeoutMs} ms`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}
