import type { AgentAction } from "../agent/actions.js";
import type { Observation } from "../browser/observation.js";
import type { NLTestCase } from "./test-case.js";

export type CaseStatus = "pass" | "fail" | "blocked";

export type StepRecord = {
  index: number;
  observation: Observation;
  action: AgentAction;
  actionResult: string;
  effort?: {
    toolCallsSinceLastAction: number;
    observations: number;
    domProbes: number;
    jsInspections: number;
  };
};

export type CaseResult = {
  case: NLTestCase;
  status: CaseStatus;
  summary: string;
  reason: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  steps: StepRecord[];
  artifactsDir: string;
  finalObservation?: Observation;
};
