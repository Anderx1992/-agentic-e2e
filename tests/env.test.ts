import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadDotEnv } from "../src/config/env.js";

test("loadDotEnv loads key value pairs and strips simple quotes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-e2e-env-"));
  const existingKey = "AGENTIC_E2E_EXISTING";
  const newKey = "AGENTIC_E2E_FROM_FILE";
  const quotedKey = "AGENTIC_E2E_QUOTED";

  const previousExisting = process.env[existingKey];
  const previousNew = process.env[newKey];
  const previousQuoted = process.env[quotedKey];

  try {
    fs.writeFileSync(
      path.join(dir, ".env"),
      [
        "# ignored",
        `${existingKey}=from-file`,
        `${newKey}=plain-value`,
        `${quotedKey}="quoted value"`,
        "MALFORMED_LINE"
      ].join("\n"),
      "utf8"
    );

    process.env[existingKey] = "already-set";
    delete process.env[newKey];
    delete process.env[quotedKey];

    loadDotEnv(dir);

    assert.equal(process.env[existingKey], "already-set");
    assert.equal(process.env[newKey], "plain-value");
    assert.equal(process.env[quotedKey], "quoted value");
  } finally {
    restoreEnv(existingKey, previousExisting);
    restoreEnv(newKey, previousNew);
    restoreEnv(quotedKey, previousQuoted);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadDotEnv does nothing when the file is missing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-e2e-env-missing-"));

  try {
    assert.doesNotThrow(() => loadDotEnv(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}
