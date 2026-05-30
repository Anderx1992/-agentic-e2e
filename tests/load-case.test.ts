import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadCase } from "../src/config/load-case.js";

test("loadCase parses a valid YAML test case", () => {
  const tempCase = writeTempCase(`
id: customer-create
name: Create customer
app:
  start_url: http://localhost:3000
task: Create a customer
success_criteria: Customer exists
constraints:
  timeout_ms: 30000
`);

  try {
    const result = loadCase(tempCase.filePath);

    assert.equal(result.id, "customer-create");
    assert.equal(result.name, "Create customer");
    assert.equal(result.app.start_url, "http://localhost:3000");
    assert.equal(result.constraints?.timeout_ms, 30000);
  } finally {
    tempCase.cleanup();
  }
});

test("loadCase rejects cases with missing required top-level fields", () => {
  const tempCase = writeTempCase(`
id: missing-name
app:
  start_url: http://localhost:3000
task: Create a customer
success_criteria: Customer exists
`);

  try {
    assert.throws(() => loadCase(tempCase.filePath), /missing name/);
  } finally {
    tempCase.cleanup();
  }
});

test("loadCase rejects cases without app.start_url", () => {
  const tempCase = writeTempCase(`
id: missing-start-url
name: Missing start URL
app: {}
task: Create a customer
success_criteria: Customer exists
`);

  try {
    assert.throws(() => loadCase(tempCase.filePath), /missing app\.start_url/);
  } finally {
    tempCase.cleanup();
  }
});

function writeTempCase(body: string): { filePath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-e2e-case-"));
  const filePath = path.join(dir, "case.yaml");
  fs.writeFileSync(filePath, body.trimStart(), "utf8");
  return {
    filePath,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true })
  };
}
