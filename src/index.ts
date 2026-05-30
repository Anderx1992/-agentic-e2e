import { loadDotEnv } from "./config/env.js";
import { runCase } from "./runner/run-case.js";
import { runSuite } from "./runner/run-suite.js";

loadDotEnv();

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const mode = args[0];
  const target = args[1];

  if (!mode || !target || (mode !== "--case" && mode !== "--suite")) {
    console.error("Usage:");
    console.error("  npm run case -- cases/customer-create.yaml");
    console.error("  npm run suite -- cases");
    process.exit(2);
  }

  if (mode === "--case") {
    const result = await runCase(target);
    console.log(`${result.status.toUpperCase()} ${result.case.id}: ${result.summary}`);
    console.log(`Report: ${result.artifactsDir}`);
    process.exit(result.status === "pass" ? 0 : 1);
  }

  const results = await runSuite(target);
  for (const result of results) {
    console.log(`${result.status.toUpperCase()} ${result.case.id}: ${result.summary}`);
    console.log(`Report: ${result.artifactsDir}`);
  }

  process.exit(results.every((result) => result.status === "pass") ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
