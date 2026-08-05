/** Redaction-safe projection from live agent events into durable audit metadata. */
import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import {
  AGENT_RUN_TERMINAL_RETRY_GRACE_MS,
  buildAgentRunTerminalOutcomeFromLifecycleEvent,
  classifyAgentRunTerminalOutcome,
  type AgentRunTerminalOutcome,
} from "../agents/agent-run-terminal-outcome.js";
import {
  isAgentEventLifecycleGenerationCurrent,
  type AgentEventPayload,
} from "../infra/agent-events.js";
import { onAgentRunContextRetired } from "../infra/agent-run-context-retirement.js";
import { getAgentRunContext } from "../infra/agent-run-registry.js";
import type { TrustedToolExecutionEvent } from "../infra/diagnostic-events.js";
import { getTrustedToolExecutionLifecycleGeneration } from "../infra/trusted-tool-execution-context.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  buildRunInstance,
  createAgentAuditProjectionState,
  deriveProvenance,
  forgetAuthoritativeOpenRun,
  forgetOpenRun,
  getAuthoritativeRunContextToken,
  hasAuthoritativeRunContext,
  MAX_TRACKED_RUN_PROVENANCE,
  nonEmptyString,
  rememberRunStart,
  rememberRunTerminal,
  retainAuthoritativeOpenRunForRetirement,
  resolveProvenance,
  resolveToolProvenance,
  type AgentAuditProjectionState,
} from "./agent-event-audit-provenance.js";
import { auditSourceIdentity } from "./agent-event-audit-source.js";
import {
  agentAuditAttemptKey,
  selectAgentAuditTerminalCandidate,
  settledAgentAuditAttemptFloor,
  type AgentAuditPendingTerminal,
  type AgentAuditProjection,
  type AgentAuditSettledRun,
  type AgentAuditTerminalCandidate,
} from "./agent-event-audit-terminal.js";
import { auditToolCallId, auditToolName } from "./agent-event-audit-tool-identity.js";
import type { AgentEventAuditRecorder } from "./agent-event-audit-types.js";
import type {
  AgentRunFinishedAuditTerminal,
  ToolActionAuditEventInput,
} from "./audit-event-types.js";
import { createAuditEventWriter, type AuditEventWriter } from "./audit-event-writer.js";

const log = createSubsystemLogger("audit/events");
let persistenceFailureWarned = false;

export type { AgentEventAuditRecorder } from "./agent-event-audit-types.js";

const AUDIT_TERMINAL_BY_CLASSIFICATION = {
  success: { status: "succeeded" as const },
  timeout: { status: "timed_out" as const, errorCode: "run_timed_out" as const },
  cancellation: { status: "cancelled" as const, errorCode: "run_cancelled" as const },
  failure: { status: "failed" as const, errorCode: "run_failed" as const },
};

function classifyRunTerminal(
  data: Record<string, unknown>,
  phase: "end" | "error",
): {
  outcome: AgentRunTerminalOutcome;
} & AgentRunFinishedAuditTerminal {
  const outcome = buildAgentRunTerminalOutcomeFromLifecycleEvent({ phase, data });
  if (outcome.reason === "blocked") {
    return { outcome, status: "blocked", errorCode: "run_blocked" };
  }
  const terminal = AUDIT_TERMINAL_BY_CLASSIFICATION[classifyAgentRunTerminalOutcome(outcome)];
  return { outcome, ...terminal };
}

function projectAgentEvent(
  state: AgentAuditProjectionState,
  event: AgentEventPayload,
): AgentAuditProjection | undefined {
  const runId = nonEmptyString(event.runId);
  const phase = nonEmptyString(event.data.phase);
  if (!runId || !phase) {
    return undefined;
  }
  const runInstance = buildRunInstance(runId, event.lifecycleGeneration);
  const isLifecycleTerminal =
    event.stream === "lifecycle" && (phase === "end" || phase === "error");
  const authoritativeToken = getAuthoritativeRunContextToken(runInstance, runId);
  const isTrackedStaleRetry =
    event.stream === "lifecycle" &&
    phase === "start" &&
    authoritativeToken !== undefined &&
    state.authoritativeOpenProvenance.has(authoritativeToken);
  const isAuthoritativeLifecycleTerminal =
    isLifecycleTerminal &&
    (state.openRunProvenance.has(runInstance) || hasAuthoritativeRunContext(runInstance, runId));
  if (
    event.lifecycleGeneration &&
    !isAgentEventLifecycleGenerationCurrent(event.lifecycleGeneration) &&
    !isAuthoritativeLifecycleTerminal &&
    !isTrackedStaleRetry
  ) {
    // Only the exact still-owned pre-rotation instance may retry or close,
    // including after bounded provenance tracking evicts its local entry.
    return undefined;
  }
  if (event.stream === "lifecycle" && phase === "start") {
    // Retry starts may reopen a completed instance. rememberRunStart reuses its
    // admitted provenance so replayed identity fields cannot replace authority.
    const provenance = rememberRunStart(
      state,
      runInstance,
      runId,
      deriveProvenance(event),
      event.lifecycleGeneration !== undefined,
    );
    const occurredAt = asDateTimestampMs(event.data.startedAt) ?? event.ts;
    const action = "agent.run.started" as const;
    return {
      input: {
        ...auditSourceIdentity({
          runId,
          sourceSequence: event.seq,
          occurredAt,
          action,
          lifecycleGeneration: event.lifecycleGeneration,
        }),
        sourceSequence: event.seq,
        occurredAt,
        kind: "agent_run",
        action,
        status: "started",
        actorType: provenance.actorType,
        actorId: provenance.agentId,
        agentId: provenance.agentId,
        ...(provenance.sessionKey ? { sessionKey: provenance.sessionKey } : {}),
        ...(provenance.sessionId ? { sessionId: provenance.sessionId } : {}),
        runId,
      },
    };
  }
  if (isLifecycleTerminal) {
    const activeRunInstance = state.activeRunInstanceByRunId.get(runId);
    const registeredLifecycleGeneration = getAgentRunContext(runId)?.lifecycleGeneration;
    if (
      !event.lifecycleGeneration &&
      !state.openRunProvenance.has(runInstance) &&
      (registeredLifecycleGeneration !== undefined ||
        (activeRunInstance && activeRunInstance !== runInstance))
    ) {
      // Gateway lifecycle emitters always stamp a generation. A legacy
      // terminal cannot be safely attached to a generated admission, so reject
      // it unless a generation-less start established its own run instance.
      return undefined;
    }
    const provenance = resolveProvenance(state, runInstance, event);
    rememberRunTerminal(state, runInstance, runId, provenance);
    const { outcome, ...terminal } = classifyRunTerminal(event.data, phase);
    const occurredAt = asDateTimestampMs(event.data.endedAt) ?? event.ts;
    const action = "agent.run.finished" as const;
    return {
      input: {
        ...auditSourceIdentity({
          runId,
          sourceSequence: event.seq,
          occurredAt,
          action,
          lifecycleGeneration: event.lifecycleGeneration,
        }),
        sourceSequence: event.seq,
        occurredAt,
        kind: "agent_run",
        action,
        ...terminal,
        actorType: provenance.actorType,
        actorId: provenance.agentId,
        agentId: provenance.agentId,
        ...(provenance.sessionKey ? { sessionKey: provenance.sessionKey } : {}),
        ...(provenance.sessionId ? { sessionId: provenance.sessionId } : {}),
        runId,
      },
      terminal: { outcome, phase },
    };
  }
  return undefined;
}

/** Project the complete trusted tool-execution lifecycle without private diagnostic content. */
function projectToolExecutionEventToAudit(
  state: AgentAuditProjectionState,
  event: TrustedToolExecutionEvent,
): ToolActionAuditEventInput | undefined {
  // Schema quarantine describes tool availability before invocation. Without
  // a call identity it must not become a durable tool-action claim.
  if (
    event.type === "tool.execution.blocked" &&
    event.deniedReason === "unsupported_tool_schema" &&
    !nonEmptyString(event.toolCallId)
  ) {
    return undefined;
  }
  const runId = nonEmptyString(event.runId);
  const toolName = auditToolName(event.toolName);
  if (!runId || !toolName) {
    return undefined;
  }
  const toolCallId = auditToolCallId(event.toolCallId);
  const capturedLifecycleGeneration = getTrustedToolExecutionLifecycleGeneration(event);
  const { provenance, lifecycleGeneration } = resolveToolProvenance(
    state,
    runId,
    event,
    capturedLifecycleGeneration,
  );
  const occurredAt = asDateTimestampMs(event.sourceTimestampMs) ?? event.ts;
  const attribution = {
    sourceSequence: event.seq,
    occurredAt,
    kind: "tool_action" as const,
    actorType: provenance.actorType,
    actorId: provenance.agentId,
    agentId: provenance.agentId,
    ...(provenance.sessionKey ? { sessionKey: provenance.sessionKey } : {}),
    ...(provenance.sessionId ? { sessionId: provenance.sessionId } : {}),
    runId,
    ...(toolCallId ? { toolCallId } : {}),
    toolName,
  };
  if (event.type === "tool.execution.started") {
    const action = "tool.action.started" as const;
    return {
      ...auditSourceIdentity({
        runId,
        sourceSequence: event.seq,
        occurredAt,
        action,
        lifecycleGeneration,
      }),
      ...attribution,
      action,
      status: "started",
    };
  }
  const errorCategory =
    event.type === "tool.execution.error"
      ? normalizeOptionalLowercaseString(event.errorCategory)
      : undefined;
  const terminalReason = event.type === "tool.execution.error" ? event.terminalReason : undefined;
  const diagnosticErrorCode =
    event.type === "tool.execution.error"
      ? normalizeOptionalLowercaseString(event.errorCode)
      : undefined;
  // Modern producers set terminalReason explicitly; errorCategory is only a
  // legacy fallback and must not override a definitive timeout or failure.
  const toolCancelled =
    terminalReason === "cancelled" ||
    (terminalReason === undefined &&
      (errorCategory === "aborted" ||
        errorCategory === "aborterror" ||
        errorCategory === "cancelled" ||
        errorCategory === "canceled"));
  const toolTimedOut = terminalReason === "timed_out";
  // Unknown is an explicit dependency boundary, not a failed-run inference.
  // Keep it authoritative when enclosing run provenance says cancel or timeout.
  const terminal =
    event.type === "tool.execution.completed"
      ? { status: "succeeded" as const }
      : event.type === "tool.execution.blocked"
        ? { status: "blocked" as const, errorCode: "tool_blocked" as const }
        : diagnosticErrorCode === "tool_outcome_unknown"
          ? { status: "unknown" as const, errorCode: "tool_outcome_unknown" as const }
          : toolCancelled
            ? { status: "cancelled" as const, errorCode: "tool_cancelled" as const }
            : toolTimedOut
              ? { status: "timed_out" as const, errorCode: "tool_timed_out" as const }
              : { status: "failed" as const, errorCode: "tool_failed" as const };
  const action = "tool.action.finished" as const;
  return {
    ...auditSourceIdentity({
      runId,
      sourceSequence: event.seq,
      occurredAt,
      action,
      lifecycleGeneration,
    }),
    ...attribution,
    action,
    ...terminal,
  };
}

/** Create the Gateway-owned non-blocking audit projection and persistence handle. */
export function createAgentEventAuditRecorder(options?: {
  writer?: AuditEventWriter;
  stateDir?: string;
  terminalSettleMs?: number;
}): AgentEventAuditRecorder {
  const projectionState = createAgentAuditProjectionState();
  const writer =
    options?.writer ??
    createAuditEventWriter({
      ...(options?.stateDir ? { stateDir: options.stateDir } : {}),
      onError: (error) => {
        if (!persistenceFailureWarned) {
          persistenceFailureWarned = true;
          log.warn(`audit event persistence failed: ${error}`);
        }
      },
    });
  const terminalSettleMs = Math.max(
    0,
    Math.floor(options?.terminalSettleMs ?? AGENT_RUN_TERMINAL_RETRY_GRACE_MS),
  );
  const pendingTerminals = new Map<string, AgentAuditPendingTerminal>();
  const rejectedTerminalsByAttempt = new Map<
    string,
    AgentAuditTerminalCandidate & { runInstance: string }
  >();
  const rejectedCountByRunInstance = new Map<string, number>();
  const openRunInstances = new Set<string>();
  const openAuthoritativeRunContexts = new WeakMap<
    object,
    { attemptEpoch: number; open: boolean; startSequence: number }
  >();
  const retiredOpenRunInstances = new Set<string>();
  const unownedOpenRunInstances = new Set<string>();
  const settledRunInstances = new Map<string, AgentAuditSettledRun>();
  const attemptEpochByRunInstance = new Map<string, number>();
  const attemptStartSequenceByRunInstance = new Map<string, number>();
  const forgetRejectedAttempt = (attemptKey: string) => {
    const rejected = rejectedTerminalsByAttempt.get(attemptKey);
    if (!rejected) {
      return;
    }
    rejectedTerminalsByAttempt.delete(attemptKey);
    const rejectedCount = (rejectedCountByRunInstance.get(rejected.runInstance) ?? 1) - 1;
    if (rejectedCount > 0) {
      rejectedCountByRunInstance.set(rejected.runInstance, rejectedCount);
    } else {
      rejectedCountByRunInstance.delete(rejected.runInstance);
      if (!openRunInstances.has(rejected.runInstance)) {
        attemptEpochByRunInstance.delete(rejected.runInstance);
      }
    }
  };
  const rememberRejectedTerminal = (runInstance: string, incoming: AgentAuditTerminalCandidate) => {
    const existing = rejectedTerminalsByAttempt.get(incoming.attemptKey);
    const selected = existing ? selectAgentAuditTerminalCandidate(existing, incoming) : incoming;
    if (!existing) {
      rejectedCountByRunInstance.set(
        runInstance,
        (rejectedCountByRunInstance.get(runInstance) ?? 0) + 1,
      );
    }
    rejectedTerminalsByAttempt.delete(incoming.attemptKey);
    rejectedTerminalsByAttempt.set(incoming.attemptKey, { ...selected, runInstance });
    if (rejectedTerminalsByAttempt.size > MAX_TRACKED_RUN_PROVENANCE) {
      const oldest = rejectedTerminalsByAttempt.keys().next().value;
      if (oldest !== undefined) {
        forgetRejectedAttempt(oldest);
      }
    }
  };
  const rememberSettled = (runInstance: string, observedThroughSequence: number) => {
    settledRunInstances.delete(runInstance);
    settledRunInstances.set(runInstance, { terminalSequence: observedThroughSequence });
    if (settledRunInstances.size > MAX_TRACKED_RUN_PROVENANCE) {
      const oldest = settledRunInstances.keys().next().value;
      if (oldest !== undefined) {
        settledRunInstances.delete(oldest);
      }
    }
  };
  const clearPending = (runInstance: string) => {
    const pending = pendingTerminals.get(runInstance);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    pendingTerminals.delete(runInstance);
  };
  const flushPending = (runInstance: string) => {
    const pending = pendingTerminals.get(runInstance);
    if (!pending) {
      return;
    }
    clearPending(runInstance);
    openRunInstances.delete(runInstance);
    const runId = nonEmptyString(pending.input.runId);
    const authoritativeContext = runId
      ? getAuthoritativeRunContextToken(runInstance, runId)
      : undefined;
    if (authoritativeContext && runId) {
      const attempt = openAuthoritativeRunContexts.get(authoritativeContext);
      if (attempt) {
        openAuthoritativeRunContexts.set(authoritativeContext, { ...attempt, open: false });
      }
      forgetAuthoritativeOpenRun(projectionState, runInstance, runId);
    }
    const rejected = rejectedTerminalsByAttempt.get(pending.attemptKey);
    const selected = rejected ? selectAgentAuditTerminalCandidate(rejected, pending) : pending;
    if (writer.record(selected.input)) {
      forgetRejectedAttempt(selected.attemptKey);
      if (runId) {
        forgetOpenRun(projectionState, runInstance, runId);
      }
      retiredOpenRunInstances.delete(runInstance);
      unownedOpenRunInstances.delete(runInstance);
      attemptStartSequenceByRunInstance.delete(runInstance);
      rememberSettled(runInstance, selected.observedThroughSequence);
      if (!rejectedCountByRunInstance.has(runInstance)) {
        attemptEpochByRunInstance.delete(runInstance);
      }
    } else {
      rememberRejectedTerminal(runInstance, selected);
    }
  };
  const scheduleTerminal = (runInstance: string, incoming: AgentAuditTerminalCandidate) => {
    const existing = pendingTerminals.get(runInstance);
    const selected = existing ? selectAgentAuditTerminalCandidate(existing, incoming) : incoming;
    if (existing) {
      clearTimeout(existing.timer);
    }
    const timer = setTimeout(() => flushPending(runInstance), terminalSettleMs);
    timer.unref?.();
    pendingTerminals.delete(runInstance);
    pendingTerminals.set(runInstance, { ...selected, timer });
    if (pendingTerminals.size > MAX_TRACKED_RUN_PROVENANCE) {
      const oldest = pendingTerminals.keys().next().value;
      if (oldest !== undefined) {
        flushPending(oldest);
      }
    }
  };
  const unsubscribeRunContextRetirement = onAgentRunContextRetired(
    ({ runId, lifecycleGeneration, contextLifecycleToken }) => {
      const runInstance = buildRunInstance(runId, lifecycleGeneration);
      const authoritativeContext =
        contextLifecycleToken ?? getAuthoritativeRunContextToken(runInstance, runId);
      const authoritativeAttempt = authoritativeContext
        ? openAuthoritativeRunContexts.get(authoritativeContext)
        : undefined;
      const authoritativeOpenAttempt = authoritativeAttempt?.open
        ? authoritativeAttempt
        : undefined;
      if (
        authoritativeAttempt &&
        (pendingTerminals.has(runInstance) || rejectedCountByRunInstance.has(runInstance))
      ) {
        attemptEpochByRunInstance.set(runInstance, authoritativeAttempt.attemptEpoch);
      }
      const retainedAuthoritativeRun = retainAuthoritativeOpenRunForRetirement(
        projectionState,
        runInstance,
        runId,
        authoritativeContext,
      );
      if (retainedAuthoritativeRun || projectionState.openRunProvenance.has(runInstance)) {
        // Context retirement can precede the final lifecycle event for every
        // registry removal path. Keep only open attempts in the bounded
        // retired set so delayed terminals retain their admitted provenance.
        if (authoritativeOpenAttempt) {
          attemptEpochByRunInstance.set(runInstance, authoritativeOpenAttempt.attemptEpoch);
          attemptStartSequenceByRunInstance.set(
            runInstance,
            authoritativeOpenAttempt.startSequence,
          );
          openRunInstances.add(runInstance);
        }
        retiredOpenRunInstances.delete(runInstance);
        retiredOpenRunInstances.add(runInstance);
        unownedOpenRunInstances.delete(runInstance);
        if (retiredOpenRunInstances.size > MAX_TRACKED_RUN_PROVENANCE) {
          const oldest = retiredOpenRunInstances.values().next().value;
          if (oldest !== undefined) {
            const separator = oldest.indexOf("\0");
            const retiredRunId = separator >= 0 ? oldest.slice(separator + 1) : oldest;
            retiredOpenRunInstances.delete(oldest);
            forgetOpenRun(projectionState, oldest, retiredRunId);
            openRunInstances.delete(oldest);
            attemptStartSequenceByRunInstance.delete(oldest);
            if (!pendingTerminals.has(oldest) && !rejectedCountByRunInstance.has(oldest)) {
              attemptEpochByRunInstance.delete(oldest);
            }
          }
        }
        return;
      }
      forgetOpenRun(projectionState, runInstance, runId);
      openRunInstances.delete(runInstance);
      retiredOpenRunInstances.delete(runInstance);
      unownedOpenRunInstances.delete(runInstance);
      attemptStartSequenceByRunInstance.delete(runInstance);
      if (!pendingTerminals.has(runInstance) && !rejectedCountByRunInstance.has(runInstance)) {
        attemptEpochByRunInstance.delete(runInstance);
      }
    },
  );
  return {
    record: (event) => {
      const runInstance = buildRunInstance(event.runId, event.lifecycleGeneration);
      const phase = nonEmptyString(event.data.phase);
      const settled = settledRunInstances.get(runInstance);
      const authoritativeContext = getAuthoritativeRunContextToken(runInstance, event.runId);
      const authoritativeAttempt = authoritativeContext
        ? openAuthoritativeRunContexts.get(authoritativeContext)
        : undefined;
      const authoritativeOpenAttempt = authoritativeAttempt?.open
        ? authoritativeAttempt
        : undefined;
      if (event.stream === "lifecycle") {
        if (phase === "start") {
          if (settled && event.seq <= settled.terminalSequence) {
            return;
          }
          const attemptEpoch =
            authoritativeAttempt?.attemptEpoch ?? attemptEpochByRunInstance.get(runInstance) ?? 0;
          const rejectedAttempt = rejectedTerminalsByAttempt.get(
            agentAuditAttemptKey(runInstance, attemptEpoch),
          );
          if (rejectedAttempt && event.seq <= rejectedAttempt.observedThroughSequence) {
            return;
          }
          const pendingTerminal = pendingTerminals.get(runInstance);
          if (pendingTerminal && event.seq <= pendingTerminal.observedThroughSequence) {
            return;
          }
          const cancelsPendingTerminal = pendingTerminal !== undefined;
          const hasOpenAttempt =
            openRunInstances.has(runInstance) || authoritativeOpenAttempt !== undefined;
          const canReplacePendingWithoutOpen =
            event.lifecycleGeneration === undefined ||
            isAgentEventLifecycleGenerationCurrent(event.lifecycleGeneration) ||
            authoritativeContext !== undefined;
          if (cancelsPendingTerminal && !hasOpenAttempt && !canReplacePendingWithoutOpen) {
            return;
          }
          if (
            !hasOpenAttempt &&
            !authoritativeContext &&
            !unownedOpenRunInstances.has(runInstance) &&
            unownedOpenRunInstances.size >= MAX_TRACKED_RUN_PROVENANCE
          ) {
            return;
          }
          if (hasOpenAttempt) {
            if (cancelsPendingTerminal) {
              clearPending(runInstance);
            }
            const startSequence = Math.max(
              event.seq,
              authoritativeOpenAttempt?.startSequence ??
                attemptStartSequenceByRunInstance.get(runInstance) ??
                event.seq,
            );
            if (authoritativeContext) {
              openAuthoritativeRunContexts.set(authoritativeContext, {
                attemptEpoch:
                  authoritativeOpenAttempt?.attemptEpoch ??
                  attemptEpochByRunInstance.get(runInstance) ??
                  1,
                open: true,
                startSequence,
              });
            } else {
              openRunInstances.add(runInstance);
              attemptStartSequenceByRunInstance.set(runInstance, startSequence);
            }
            return;
          }
          if (cancelsPendingTerminal) {
            clearPending(runInstance);
          }
        } else if (phase === "end" || phase === "error") {
          const attemptStartSequence =
            authoritativeOpenAttempt?.startSequence ??
            attemptStartSequenceByRunInstance.get(runInstance);
          const settledAttemptFloor = settledAgentAuditAttemptFloor(settled);
          if (
            (attemptStartSequence !== undefined && event.seq <= attemptStartSequence) ||
            (settledAttemptFloor !== undefined && event.seq <= settledAttemptFloor)
          ) {
            return;
          }
        }
      }
      const projection = projectAgentEvent(projectionState, event);
      if (!projection) {
        return;
      }
      if (!projection.terminal) {
        // Retry starts cancel a provisional terminal for the same logical run.
        // A writer-rejected terminal already crossed the settle boundary and
        // remains a prior attempt; queue pressure must not rewrite that history.
        if (authoritativeContext) {
          // Registry-owned weak identity carries authoritative live attempt
          // state without retaining completed run contexts.
          openAuthoritativeRunContexts.set(authoritativeContext, {
            attemptEpoch: (authoritativeAttempt?.attemptEpoch ?? 0) + 1,
            open: true,
            startSequence: event.seq,
          });
        } else {
          attemptEpochByRunInstance.set(
            runInstance,
            (attemptEpochByRunInstance.get(runInstance) ?? 0) + 1,
          );
          openRunInstances.add(runInstance);
          attemptStartSequenceByRunInstance.set(runInstance, event.seq);
        }
        if (settled) {
          settledRunInstances.delete(runInstance);
          settledRunInstances.set(runInstance, {
            ...settled,
            reopenedStartSequence: event.seq,
          });
        }
        writer.record(projection.input);
        if (hasAuthoritativeRunContext(runInstance, event.runId)) {
          unownedOpenRunInstances.delete(runInstance);
        } else {
          unownedOpenRunInstances.delete(runInstance);
          unownedOpenRunInstances.add(runInstance);
        }
        return;
      }
      if (
        projection.terminal.outcome.reason === "completed" &&
        !pendingTerminals.has(runInstance)
      ) {
        const attemptKey = agentAuditAttemptKey(
          runInstance,
          authoritativeAttempt?.attemptEpoch ?? attemptEpochByRunInstance.get(runInstance) ?? 0,
        );
        const incoming = {
          attemptKey,
          input: projection.input,
          observedThroughSequence: event.seq,
          ...projection.terminal,
        };
        const rejected = rejectedTerminalsByAttempt.get(attemptKey);
        const selected = rejected
          ? selectAgentAuditTerminalCandidate(rejected, incoming)
          : incoming;
        openRunInstances.delete(runInstance);
        const terminalAuthoritativeContext = getAuthoritativeRunContextToken(
          runInstance,
          event.runId,
        );
        if (terminalAuthoritativeContext) {
          // The terminal has crossed the settle boundary even when the writer
          // queues it for stop(); a later start therefore owns a new attempt.
          if (authoritativeAttempt) {
            openAuthoritativeRunContexts.set(terminalAuthoritativeContext, {
              ...authoritativeAttempt,
              open: false,
            });
          }
          forgetAuthoritativeOpenRun(projectionState, runInstance, event.runId);
        }
        if (writer.record(selected.input)) {
          forgetRejectedAttempt(attemptKey);
          forgetOpenRun(projectionState, runInstance, event.runId);
          retiredOpenRunInstances.delete(runInstance);
          unownedOpenRunInstances.delete(runInstance);
          attemptStartSequenceByRunInstance.delete(runInstance);
          rememberSettled(runInstance, selected.observedThroughSequence);
          if (!rejectedCountByRunInstance.has(runInstance)) {
            attemptEpochByRunInstance.delete(runInstance);
          }
        } else {
          rememberRejectedTerminal(runInstance, selected);
        }
        return;
      }
      scheduleTerminal(runInstance, {
        attemptKey: agentAuditAttemptKey(
          runInstance,
          authoritativeAttempt?.attemptEpoch ?? attemptEpochByRunInstance.get(runInstance) ?? 0,
        ),
        input: projection.input,
        observedThroughSequence: event.seq,
        ...projection.terminal,
      });
    },
    recordTool: (event) => {
      const input = projectToolExecutionEventToAudit(projectionState, event);
      if (input) {
        writer.record(input);
      }
    },
    stop: async () => {
      for (const runInstance of pendingTerminals.keys()) {
        flushPending(runInstance);
      }
      try {
        await writer.stop(
          [...rejectedTerminalsByAttempt.values()].map((rejected) => rejected.input),
        );
      } finally {
        unsubscribeRunContextRetirement();
        // The registry remains authoritative when bounded projection entries
        // are evicted. Shutdown releases every local projection.
        projectionState.openRunProvenance.clear();
        projectionState.runProvenance.clear();
        projectionState.activeRunInstanceByRunId.clear();
        projectionState.seenRunInstances.clear();
        rejectedTerminalsByAttempt.clear();
        rejectedCountByRunInstance.clear();
        retiredOpenRunInstances.clear();
        unownedOpenRunInstances.clear();
        attemptEpochByRunInstance.clear();
      }
    },
  };
}
