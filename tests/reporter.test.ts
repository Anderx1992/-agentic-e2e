import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeReports } from "../src/report/reporter.js";
import type { CaseResult } from "../src/types/result.js";

test("writeReports writes JSON and escaped HTML report files", () => {
  const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-e2e-report-"));
  const result: CaseResult = {
    case: {
      id: "html-escaping",
      name: "Escapes <customer>",
      app: {
        start_url: "http://localhost:3000/?q=<script>"
      },
      task: "Create <customer>",
      success_criteria: "No raw HTML"
    },
    status: "fail",
    summary: "Summary with <tag>",
    reason: "Reason with \"quotes\" & ampersand",
    startedAt: "2026-05-30T00:00:00.000Z",
    finishedAt: "2026-05-30T00:00:01.000Z",
    durationMs: 1000,
    artifactsDir,
    steps: [
      {
        index: 1,
        action: {
          type: "click",
          x: 10,
          y: 20,
          reason: "Click <button>"
        },
        actionResult: "Clicked & navigated",
        observation: {
          url: "http://localhost:3000/customers",
          title: "Customers",
          visibleText: "Customers",
          screenshotPath: path.join(artifactsDir, "screen one.png")
        }
      }
    ]
  };

  try {
    const paths = writeReports(result);
    const json = JSON.parse(fs.readFileSync(paths.jsonPath, "utf8")) as CaseResult;
    const html = fs.readFileSync(paths.htmlPath, "utf8");

    assert.equal(json.case.id, "html-escaping");
    assert.equal(json.status, "fail");
    assert.match(html, /Escapes &lt;customer&gt;/);
    assert.match(html, /Reason with &quot;quotes&quot; &amp; ampersand/);
    assert.match(html, /Click &lt;button&gt;/);
    assert.match(html, /file:\/\/\//);
    assert.ok(fs.existsSync(path.join(artifactsDir, "result.json")));
    assert.ok(fs.existsSync(path.join(artifactsDir, "report.html")));
  } finally {
    fs.rmSync(artifactsDir, { recursive: true, force: true });
  }
});
