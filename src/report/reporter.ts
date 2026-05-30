import fs from "node:fs";
import path from "node:path";
import type { CaseResult } from "../types/result.js";

export function writeReports(result: CaseResult): { jsonPath: string; htmlPath: string } {
  fs.mkdirSync(result.artifactsDir, { recursive: true });

  const jsonPath = path.join(result.artifactsDir, "result.json");
  const htmlPath = path.join(result.artifactsDir, "report.html");

  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2), "utf8");
  fs.writeFileSync(htmlPath, renderHtml(result), "utf8");

  return { jsonPath, htmlPath };
}

function renderHtml(result: CaseResult): string {
  const badgeColor =
    result.status === "pass" ? "#17803d" : result.status === "fail" ? "#b42318" : "#9a6700";

  const steps = result.steps
    .map(
      (step) => `
        <section class="step">
          <h2>Step ${step.index}: ${escapeHtml(step.action.type)}</h2>
          <p><strong>Reason:</strong> ${escapeHtml(step.action.reason)}</p>
          <p><strong>URL:</strong> ${escapeHtml(step.observation.url)}</p>
          ${step.observation.screenshotPath ? `<img src="${toFileHref(step.observation.screenshotPath)}" />` : ""}
          <details>
            <summary>Action result</summary>
            <pre>${escapeHtml(step.actionResult)}</pre>
          </details>
        </section>`
    )
    .join("\n");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(result.case.name)} - ${result.status}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 32px; color: #1f2328; background: #f6f8fa; }
    main { max-width: 1080px; margin: 0 auto; }
    .summary, .step { background: white; border: 1px solid #d0d7de; border-radius: 8px; padding: 20px; margin-bottom: 16px; }
    .badge { display: inline-block; background: ${badgeColor}; color: white; padding: 4px 10px; border-radius: 999px; font-weight: 700; }
    h1 { margin: 0 0 12px; }
    h2 { margin: 0 0 10px; font-size: 18px; }
    img { max-width: 100%; border: 1px solid #d0d7de; border-radius: 6px; margin-top: 10px; }
    pre { white-space: pre-wrap; word-break: break-word; background: #f6f8fa; padding: 12px; border-radius: 6px; }
  </style>
</head>
<body>
  <main>
    <section class="summary">
      <h1>${escapeHtml(result.case.name)} <span class="badge">${result.status.toUpperCase()}</span></h1>
      <p>${escapeHtml(result.summary)}</p>
      <p><strong>Reason:</strong> ${escapeHtml(result.reason)}</p>
      <p><strong>Duration:</strong> ${result.durationMs} ms</p>
      <p><strong>Start URL:</strong> ${escapeHtml(result.case.app.start_url)}</p>
      <details>
        <summary>Natural-language case</summary>
        <pre>${escapeHtml(JSON.stringify(result.case, null, 2))}</pre>
      </details>
    </section>
    ${steps}
  </main>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function toFileHref(filePath: string): string {
  return `file:///${filePath.replaceAll("\\", "/")}`;
}
