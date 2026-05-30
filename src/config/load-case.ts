import fs from "node:fs";
import YAML from "yaml";
import type { NLTestCase } from "../types/test-case.js";

export function loadCase(filePath: string): NLTestCase {
  const raw = fs.readFileSync(filePath, "utf8");
  const data = YAML.parse(raw) as NLTestCase;

  for (const field of ["id", "name", "task", "success_criteria"] as const) {
    if (!data[field]) throw new Error(`Invalid case ${filePath}: missing ${field}`);
  }

  if (!data.app?.start_url) {
    throw new Error(`Invalid case ${filePath}: missing app.start_url`);
  }

  return data;
}
