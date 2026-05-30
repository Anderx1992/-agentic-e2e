import fs from "node:fs";
import path from "node:path";
import { runCase } from "./run-case.js";
import type { CaseResult } from "../types/result.js";

export async function runSuite(casesDir: string): Promise<CaseResult[]> {
  const files = fs
    .readdirSync(casesDir)
    .filter((name) => name.endsWith(".yaml") || name.endsWith(".yml"))
    .map((name) => path.join(casesDir, name));

  const results: CaseResult[] = [];
  for (const file of files) {
    results.push(await runCase(file));
  }
  return results;
}
