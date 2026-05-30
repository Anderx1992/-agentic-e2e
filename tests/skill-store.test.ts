import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SkillStore } from "../src/skills/skill-store.js";
import type { ValidatedAgentSkill } from "../src/skills/agent-skill.js";
import type { CaseResult } from "../src/types/result.js";

test("SkillStore learns high-effort steps into markdown skills", () => {
  const skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-e2e-skills-"));
  const store = new SkillStore(skillsDir);
  const result: CaseResult = {
    case: {
      id: "customer-create-001",
      name: "Create customer",
      app: {
        start_url: "http://localhost:3000/admin/customers"
      },
      task: "Create customer",
      success_criteria: "Customer appears"
    },
    status: "pass",
    summary: "ok",
    reason: "ok",
    startedAt: "2026-05-30T00:00:00.000Z",
    finishedAt: "2026-05-30T00:00:01.000Z",
    durationMs: 1000,
    artifactsDir: skillsDir,
    steps: [
      {
        index: 1,
        action: {
          type: "clickRef",
          ref: "e1",
          reason: "Click create"
        },
        actionResult: "{}",
        observation: {
          url: "http://localhost:3000/admin/customers",
          title: "Customers",
          visibleText: "Create",
          consoleErrors: [],
          failedRequests: [],
          timestamp: "2026-05-30T00:00:00.000Z",
          ariaNodes: [
            {
              ref: "e1",
              role: "button",
              name: "Create",
              tag: "button",
              selector: "#create",
              text: "Create",
              bounds: { x: 1, y: 2, width: 80, height: 32 }
            }
          ]
        },
        effort: {
          toolCallsSinceLastAction: 3,
          observations: 1,
          domProbes: 1,
          jsInspections: 0
        }
      }
    ]
  };

  try {
    const learned = store.learnFromResult(result);
    assert.equal(learned.length, 1);

    const files = fs.readdirSync(skillsDir);
    assert.equal(files.length, 1);
    assert.match(files[0], /\.md$/);

    const content = fs.readFileSync(path.join(skillsDir, files[0]), "utf8");
    assert.match(content, /^---\n/);
    assert.match(content, /# Create customer: click Create/);
    assert.match(content, /selector: "#create"/);
    assert.doesNotMatch(content, /\.json/);

    const validatedSkill: ValidatedAgentSkill = {
      ...learned[0],
      validationResult: "verified",
      diagnostics: {
        probeScripts: ["return all('button').map((button) => ref(button));"],
        jsInspections: []
      }
    };
    const index = store.formatIndexForPrompt([validatedSkill]);
    const detail = store.formatSkillDetail(validatedSkill);

    assert.match(index, /Validated agent-skill index/);
    assert.match(index, /read_agent_skill/);
    assert.match(index, new RegExp(validatedSkill.id));
    assert.doesNotMatch(index, /return all\('button'\)/);
    assert.match(detail, /return all\('button'\)/);
  } finally {
    fs.rmSync(skillsDir, { recursive: true, force: true });
  }
});
