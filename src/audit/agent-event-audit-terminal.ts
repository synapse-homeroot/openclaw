import {
  mergeAgentRunTerminalOutcome,
  type AgentRunTerminalOutcome,
} from "../agents/agent-run-terminal-outcome.js";
import type { AuditEventInput } from "./audit-event-types.js";

export type AgentAuditProjection = {
  input: AuditEventInput;
  terminal?: { outcome: AgentRunTerminalOutcome; phase: "end" | "error" };
};

export type AgentAuditTerminalCandidate = {
  attemptKey: string;
  input: AuditEventInput;
  observedThroughSequence: number;
  outcome: AgentRunTerminalOutcome;
  phase: "end" | "error";
};

export type AgentAuditPendingTerminal = AgentAuditTerminalCandidate & {
  timer: ReturnType<typeof setTimeout>;
};

export type AgentAuditSettledRun = {
  terminalSequence: number;
  reopenedStartSequence?: number;
};

export function agentAuditAttemptKey(runInstance: string, attemptEpoch: number): string {
  return `${runInstance}\0${attemptEpoch}`;
}

export function settledAgentAuditAttemptFloor(
  settled: AgentAuditSettledRun | undefined,
): number | undefined {
  return settled
    ? Math.max(settled.terminalSequence, settled.reopenedStartSequence ?? Number.POSITIVE_INFINITY)
    : undefined;
}

export function selectAgentAuditTerminalCandidate(
  existing: AgentAuditTerminalCandidate,
  incoming: AgentAuditTerminalCandidate,
): AgentAuditTerminalCandidate {
  // A bare cleanup end can follow a definitive error without a retry start.
  // Otherwise use the shared sticky timeout/cancellation merge contract.
  const cleanupAfterError =
    existing.phase === "error" &&
    incoming.phase === "end" &&
    incoming.outcome.reason === "completed";
  if (cleanupAfterError) {
    return {
      ...existing,
      observedThroughSequence: Math.max(
        existing.observedThroughSequence,
        incoming.observedThroughSequence,
      ),
    };
  }
  const merged = mergeAgentRunTerminalOutcome(existing.outcome, incoming.outcome);
  const selected = merged === existing.outcome ? existing : incoming;
  return {
    ...selected,
    observedThroughSequence: Math.max(
      existing.observedThroughSequence,
      incoming.observedThroughSequence,
    ),
  };
}
