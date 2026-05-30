export type AgentAction =
  | { type: "navigate"; url: string; reason: string }
  | { type: "click"; x: number; y: number; reason: string }
  | { type: "type"; text: string; reason: string }
  | { type: "press"; key: string; reason: string }
  | { type: "scroll"; deltaY: number; reason: string }
  | { type: "wait"; ms: number; reason: string }
  | { type: "js"; code: string; reason: string }
  | { type: "done"; result: "pass" | "fail" | "blocked"; reason: string; summary: string };

export type AgentDecision = AgentAction;

export function isDoneAction(action: AgentAction): action is Extract<AgentAction, { type: "done" }> {
  return action.type === "done";
}
