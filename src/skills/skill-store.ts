import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import YAML from "yaml";
import type { AgentAction } from "../agent/actions.js";
import type { AriaNodeSummary } from "../browser/observation.js";
import type { CaseResult, StepRecord } from "../types/result.js";
import type { NLTestCase } from "../types/test-case.js";
import type { AgentSkill, ValidatedAgentSkill } from "./agent-skill.js";

const SCHEMA_VERSION = 1;
const DEFAULT_SKILLS_DIR = "agent-skills";
const FRONTMATTER = "---";
const SKILL_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_PROMPT_SKILLS = 6;
const MIN_EFFORT_TO_LEARN = 3;

export class SkillStore {
  constructor(private readonly rootDir = path.resolve(DEFAULT_SKILLS_DIR)) {}

  async loadForCase(testCase: NLTestCase, page: Page): Promise<ValidatedAgentSkill[]> {
    const candidates = this.readAll()
      .filter((skill) => skill.lifecycle.status !== "retired")
      .filter((skill) => matchesCase(skill, testCase))
      .sort((a, b) => scoreSkill(b, testCase) - scoreSkill(a, testCase))
      .slice(0, MAX_PROMPT_SKILLS * 2);

    const validated: ValidatedAgentSkill[] = [];
    for (const skill of candidates) {
      const result = await this.validate(skill, page);
      if (result) validated.push(result);
      if (validated.length >= MAX_PROMPT_SKILLS) break;
    }
    return validated;
  }

  formatIndexForPrompt(skills: ValidatedAgentSkill[]): string {
    if (!skills.length) return "";

    return [
      "Validated agent-skill index from previous runs. This is only an index, not the full skill content.",
      "Treat skills as fallible hints. If one looks useful, call read_agent_skill with its id before applying details.",
      ...skills.map((skill) =>
        [
          `Skill ${skill.id} (${skill.validationResult}, confidence ${skill.lifecycle.confidence.toFixed(2)}): ${skill.title}`,
          `Scope: ${skill.scope.origin}${skill.scope.pathPrefix ?? ""}`,
          skill.target?.text ? `Target hint: ${skill.target.text}` : undefined,
          skill.target?.role ? `Role hint: ${skill.target.role}` : undefined,
          skill.validation.selector ? `Has selector validation: yes` : `Has selector validation: no`,
          `Updated: ${skill.lifecycle.updatedAt}`
        ]
          .filter(Boolean)
          .join("\n")
      )
    ].join("\n\n");
  }

  formatSkillDetail(skill: ValidatedAgentSkill): string {
    return [
      `# ${skill.title}`,
      "",
      `ID: ${skill.id}`,
      `Validation: ${skill.validationResult}`,
      `Confidence: ${skill.lifecycle.confidence.toFixed(2)}`,
      `Expires: ${skill.lifecycle.expiresAt}`,
      "",
      "## Guidance",
      "",
      skill.guidance,
      "",
      "## Current Validation Hints",
      "",
      skill.validation.selector ? `- Selector: \`${skill.validation.selector}\`` : "- Selector: none",
      skill.validation.textIncludes ? `- Text includes: ${skill.validation.textIncludes}` : "- Text includes: none",
      skill.target?.role ? `- Role: ${skill.target.role}` : undefined,
      skill.target?.name ? `- Name: ${skill.target.name}` : undefined,
      skill.target?.tag ? `- Tag: ${skill.target.tag}` : undefined,
      "",
      "## Learned Diagnostics",
      "",
      ...(skill.diagnostics?.probeScripts.length
        ? skill.diagnostics.probeScripts.map((script, index) => `Probe ${index + 1}:\n\`\`\`js\n${script}\n\`\`\``)
        : ["No prior probe scripts recorded."]),
      ...(skill.diagnostics?.jsInspections.length
        ? skill.diagnostics.jsInspections.map((script, index) => `JS inspection ${index + 1}:\n\`\`\`js\n${script}\n\`\`\``)
        : []),
      "",
      "Use this only after verifying it still matches the current DOM. If it does not match, ignore it and generate a fresh probe_dom script."
    ]
      .filter((line) => line !== undefined)
      .join("\n");
  }

  learnFromResult(result: CaseResult): AgentSkill[] {
    if (result.status !== "pass") return [];

    const learned: AgentSkill[] = [];
    for (const step of result.steps) {
      if (!isLearnableStep(step)) continue;

      const skill = this.buildSkill(result, step);
      if (!skill) continue;

      const saved = this.upsert(skill);
      learned.push(saved);
    }
    return learned;
  }

  private async validate(skill: AgentSkill, page: Page): Promise<ValidatedAgentSkill | undefined> {
    const now = new Date();
    if (Date.parse(skill.lifecycle.expiresAt) <= now.getTime()) {
      this.markStale(skill, "expired");
      return undefined;
    }

    const selector = skill.validation.selector;
    if (!selector) {
      return { ...skill, validationResult: "unverified" };
    }

    const matched = await page
      .locator(selector)
      .first()
      .evaluate((element, textIncludes) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        const visible = rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
        const text = `${element.textContent ?? ""} ${(element as HTMLInputElement).value ?? ""}`.replace(/\s+/g, " ");
        return visible && (!textIncludes || text.includes(textIncludes));
      }, skill.validation.textIncludes ?? "")
      .catch(() => false);

    if (!matched) {
      this.markStale(skill, `selector no longer matches current page: ${selector}`);
      return undefined;
    }

    const verified: AgentSkill = {
      ...skill,
      lifecycle: {
        ...skill.lifecycle,
        status: "active",
        lastVerifiedAt: now.toISOString(),
        staleReason: undefined
      }
    };
    this.write(verified);
    return { ...verified, validationResult: "verified" };
  }

  private buildSkill(result: CaseResult, step: StepRecord): AgentSkill | undefined {
    const target = targetFromStep(result.steps, step);
    if (!target.selector && !target.text) return undefined;

    const now = new Date();
    const url = new URL(step.observation.url);
    const diagnostics = diagnosticsBefore(result.steps, step.index);
    const action = normalizeAction(step.action, target);
    const id = skillId(result.case, action, target);
    const title = `${result.case.name}: ${describeAction(action, target)}`;

    return {
      schemaVersion: SCHEMA_VERSION,
      id,
      title,
      scope: {
        origin: url.origin,
        pathPrefix: url.pathname.split("/").slice(0, 3).join("/") || "/",
        caseId: result.case.id,
        taskKeywords: keywords(result.case.task)
      },
      trigger: `When running case ${result.case.id} on ${url.origin}${url.pathname} and the agent spends extra rounds locating the target.`,
      guidance: buildGuidance(action, target),
      action,
      target,
      diagnostics,
      validation: {
        selector: target.selector,
        textIncludes: target.text ? target.text.slice(0, 80) : undefined
      },
      evidence: {
        caseId: result.case.id,
        stepIndex: step.index,
        observationUrl: step.observation.url,
        observationTitle: step.observation.title,
        effort: step.effort!
      },
      lifecycle: {
        status: "active",
        confidence: 0.55,
        successCount: 1,
        validationFailureCount: 0,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        lastVerifiedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + SKILL_TTL_MS).toISOString()
      }
    };
  }

  private upsert(skill: AgentSkill): AgentSkill {
    const existing = this.read(skill.id);
    if (!existing) {
      this.write(skill);
      return skill;
    }

    const now = new Date();
    const merged: AgentSkill = {
      ...skill,
      lifecycle: {
        ...skill.lifecycle,
        confidence: Math.min(0.95, existing.lifecycle.confidence + 0.1),
        successCount: existing.lifecycle.successCount + 1,
        validationFailureCount: 0,
        createdAt: existing.lifecycle.createdAt,
        updatedAt: now.toISOString(),
        lastVerifiedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + SKILL_TTL_MS).toISOString()
      }
    };
    this.write(merged);
    return merged;
  }

  private markStale(skill: AgentSkill, reason: string): void {
    const failureCount = skill.lifecycle.validationFailureCount + 1;
    const updated: AgentSkill = {
      ...skill,
      lifecycle: {
        ...skill.lifecycle,
        status: failureCount >= 3 ? "retired" : "stale",
        confidence: Math.max(0, skill.lifecycle.confidence - 0.2),
        validationFailureCount: failureCount,
        updatedAt: new Date().toISOString(),
        staleReason: reason
      }
    };
    this.write(updated);
  }

  private readAll(): AgentSkill[] {
    if (!fs.existsSync(this.rootDir)) return [];
    return fs
      .readdirSync(this.rootDir)
      .filter((name) => name.endsWith(".md"))
      .flatMap((name) => {
        const skill = this.read(path.basename(name, ".md"));
        return skill ? [skill] : [];
      });
  }

  private read(id: string): AgentSkill | undefined {
    const filePath = path.join(this.rootDir, `${id}.md`);
    if (!fs.existsSync(filePath)) return undefined;
    try {
      const parsed = parseSkillMarkdown(fs.readFileSync(filePath, "utf8"));
      return parsed.schemaVersion === SCHEMA_VERSION ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  private write(skill: AgentSkill): void {
    fs.mkdirSync(this.rootDir, { recursive: true });
    fs.writeFileSync(path.join(this.rootDir, `${skill.id}.md`), renderSkillMarkdown(skill), "utf8");
  }
}

function parseSkillMarkdown(raw: string): AgentSkill {
  if (!raw.startsWith(FRONTMATTER)) {
    throw new Error("Skill markdown is missing front matter");
  }

  const end = raw.indexOf(`\n${FRONTMATTER}`, FRONTMATTER.length);
  if (end === -1) {
    throw new Error("Skill markdown front matter is not closed");
  }

  const frontMatter = raw.slice(FRONTMATTER.length, end).trim();
  return YAML.parse(frontMatter) as AgentSkill;
}

function renderSkillMarkdown(skill: AgentSkill): string {
  const metadata = YAML.stringify(skill).trimEnd();
  return `${FRONTMATTER}\n${metadata}\n${FRONTMATTER}\n\n# ${skill.title}\n\n${skill.guidance}\n\n## When To Use\n\n${skill.trigger}\n\n## Validation\n\n- Status: ${skill.lifecycle.status}\n- Confidence: ${skill.lifecycle.confidence.toFixed(2)}\n- Expires: ${skill.lifecycle.expiresAt}\n${
    skill.validation.selector ? `- Selector: \`${skill.validation.selector}\`\n` : ""
  }${skill.validation.textIncludes ? `- Text includes: ${skill.validation.textIncludes}\n` : ""}\n## Notes\n\nThis skill is a fallible hint learned from a previous run. Verify the current DOM before using it; if validation fails, generate a fresh \`probe_dom\` script and let the next successful run update this file.\n`;
}

function isLearnableStep(step: StepRecord): boolean {
  if (!step.effort || step.effort.toolCallsSinceLastAction < MIN_EFFORT_TO_LEARN) return false;
  return ["clickRef", "typeRef", "click", "type"].includes(step.action.type);
}

function matchesCase(skill: AgentSkill, testCase: NLTestCase): boolean {
  const startUrl = new URL(testCase.app.start_url);
  if (skill.scope.origin !== startUrl.origin) return false;
  if (skill.scope.caseId === testCase.id) return true;
  return skill.scope.taskKeywords.some((keyword) => testCase.task.includes(keyword));
}

function scoreSkill(skill: AgentSkill, testCase: NLTestCase): number {
  let score = skill.lifecycle.confidence;
  if (skill.scope.caseId === testCase.id) score += 2;
  score += skill.scope.taskKeywords.filter((keyword) => testCase.task.includes(keyword)).length * 0.2;
  if (skill.lifecycle.status === "stale") score -= 1;
  return score;
}

function targetFromStep(steps: StepRecord[], step: StepRecord): NonNullable<AgentSkill["target"]> {
  if (step.action.type === "clickRef" || step.action.type === "typeRef") {
    const node = findNodeForRef(steps, step);
    return {
      selector: node?.selector,
      role: node?.role,
      name: node?.name,
      text: node?.name || node?.text || node?.placeholder,
      tag: node?.tag
    };
  }

  return {
    text: step.observation.visibleText.slice(0, 120)
  };
}

function findNodeForRef(steps: StepRecord[], step: StepRecord): AriaNodeSummary | undefined {
  if (step.action.type !== "clickRef" && step.action.type !== "typeRef") return undefined;
  const ref = step.action.ref;
  const current = step.observation.ariaNodes?.find((node) => node.ref === ref);
  if (current) return current;

  for (const previous of [...steps].reverse()) {
    if (previous.index >= step.index) continue;
    const parsed = parseActionResult(previous.actionResult);
    const node = parsed?.nodes?.find((item): item is { ref: string } => isObjectWithRef(item) && item.ref === ref);
    if (node) return node as AriaNodeSummary;
  }
  return undefined;
}

function diagnosticsBefore(steps: StepRecord[], stepIndex: number): AgentSkill["diagnostics"] {
  const recent = steps.filter((step) => step.index < stepIndex).slice(-6);
  return {
    probeScripts: recent
      .filter((step) => step.action.type === "probeDom")
      .map((step) => (step.action as Extract<AgentAction, { type: "probeDom" }>).code)
      .slice(-2),
    jsInspections: recent
      .filter((step) => step.action.type === "js")
      .map((step) => (step.action as Extract<AgentAction, { type: "js" }>).code)
      .slice(-2)
  };
}

function normalizeAction(action: AgentAction, target: AgentSkill["target"]): AgentAction {
  if (action.type === "clickRef" && target?.selector) {
    return { ...action, ref: "<verify-current-ref>" };
  }
  if (action.type === "typeRef" && target?.selector) {
    return { ...action, ref: "<verify-current-ref>" };
  }
  return action;
}

function buildGuidance(action: AgentAction, target: AgentSkill["target"]): string {
  const selector = target?.selector ? ` First verify selector ${target.selector}.` : "";
  const text = target?.text ? ` Target text/name: ${target.text}.` : "";
  if (action.type === "typeRef") {
    return `If the current DOM still matches, register the current element with ref(...) or use the observed aria ref, then type the required value.${selector}${text}`;
  }
  if (action.type === "clickRef") {
    return `If the current DOM still matches, register the current element with ref(...) or use the observed aria ref, then click it.${selector}${text}`;
  }
  return `Use this as a hint for the next action only after verifying the current DOM.${selector}${text}`;
}

function describeAction(action: AgentAction, target: AgentSkill["target"]): string {
  const targetName = target?.text || target?.selector || "target element";
  if (action.type === "typeRef" || action.type === "type") return `type into ${targetName}`;
  if (action.type === "clickRef" || action.type === "click") return `click ${targetName}`;
  return action.type;
}

function skillId(testCase: NLTestCase, action: AgentAction, target: AgentSkill["target"]): string {
  const input = JSON.stringify({
    caseId: testCase.id,
    action: action.type,
    selector: target?.selector,
    text: target?.text
  });
  return `skill-${crypto.createHash("sha1").update(input).digest("hex").slice(0, 12)}`;
}

function keywords(text: string): string[] {
  return Array.from(
    new Set(
      text
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .split(/\s+/)
        .map((item) => item.trim())
        .filter((item) => item.length >= 2)
        .slice(0, 12)
    )
  );
}

function parseActionResult(value: string): { nodes?: unknown[] } | undefined {
  try {
    return JSON.parse(value) as { nodes?: unknown[] };
  } catch {
    return undefined;
  }
}

function isObjectWithRef(value: unknown): value is { ref: string } {
  return typeof value === "object" && value !== null && "ref" in value && typeof (value as { ref?: unknown }).ref === "string";
}
