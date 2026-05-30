import type { AgentAction } from "../agent/actions.js";

export type AgentSkillStatus = "active" | "stale" | "retired";

export type AgentSkill = {
  schemaVersion: 1;
  id: string;
  title: string;
  scope: {
    origin: string;
    pathPrefix?: string;
    caseId?: string;
    taskKeywords: string[];
  };
  trigger: string;
  guidance: string;
  action: AgentAction;
  target?: {
    selector?: string;
    role?: string;
    name?: string;
    text?: string;
    tag?: string;
  };
  diagnostics?: {
    probeScripts: string[];
    jsInspections: string[];
  };
  validation: {
    selector?: string;
    textIncludes?: string;
  };
  evidence: {
    caseId: string;
    stepIndex: number;
    observationUrl: string;
    observationTitle: string;
    effort: {
      toolCallsSinceLastAction: number;
      observations: number;
      domProbes: number;
      jsInspections: number;
    };
  };
  lifecycle: {
    status: AgentSkillStatus;
    confidence: number;
    successCount: number;
    validationFailureCount: number;
    createdAt: string;
    updatedAt: string;
    lastVerifiedAt?: string;
    expiresAt: string;
    staleReason?: string;
  };
};

export type ValidatedAgentSkill = AgentSkill & {
  validationResult: "verified" | "unverified";
};
