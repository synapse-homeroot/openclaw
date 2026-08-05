import { beforeEach, describe, expect, test } from "vitest";
import { createAgentExecutionAttribution } from "../agents/agent-execution-attribution.js";
import {
  type AgentEventPayload,
  emitAgentAuditEvent,
  emitAgentEvent,
  getAgentEventLifecycleGeneration,
  onAgentAuditEvent,
  onAgentEvent,
  resetAgentEventsForTest,
  rotateAgentEventLifecycleGeneration,
  withAgentRunLifecycleGeneration,
} from "./agent-events.js";
import { onAgentRunContextRetired } from "./agent-run-context-retirement.js";
import {
  claimAgentRunContext,
  clearAgentRunContext,
  getAgentRunContext,
  registerAgentRunContext,
} from "./agent-run-registry.js";

describe("agent event execution attribution", () => {
  beforeEach(() => {
    resetAgentEventsForTest();
  });

  test("keeps the first same-generation attribution private and immutable", () => {
    const attribution = createAgentExecutionAttribution({
      runId: "run-ctx",
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      sessionKey: "agent:main:main",
      sessionId: "session-1",
      agentId: "main",
    });
    const replacement = createAgentExecutionAttribution({
      runId: "run-ctx",
      lifecycleGeneration: attribution.lifecycleGeneration,
      sessionKey: "agent:main:other",
      sessionId: "session-2",
      agentId: "main",
    });
    registerAgentRunContext("run-ctx", {
      attribution,
      lifecycleGeneration: attribution.lifecycleGeneration,
    });
    registerAgentRunContext("run-ctx", {
      attribution: replacement,
      lifecycleGeneration: attribution.lifecycleGeneration,
      verboseLevel: "full",
    });

    expect(getAgentRunContext("run-ctx")?.attribution).toBe(attribution);
    expect(getAgentRunContext("run-ctx")?.verboseLevel).toBe("full");
    expect(Reflect.set(getAgentRunContext("run-ctx")!, "attribution", replacement)).toBe(false);

    let received: AgentEventPayload | undefined;
    const stop = onAgentEvent((event) => {
      received = event;
    });
    emitAgentEvent({ runId: "run-ctx", stream: "lifecycle", data: { phase: "end" } });
    stop();

    expect(JSON.stringify(received)).not.toContain("attribution");
  });

  test("projects admission attribution only onto private audit events", () => {
    const attribution = createAgentExecutionAttribution({
      runId: "run-audit-attribution",
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      sessionKey: "agent:main:admitted",
      sessionId: "session-admitted",
      agentId: "main",
    });
    registerAgentRunContext(attribution.runId, {
      attribution,
      lifecycleGeneration: attribution.lifecycleGeneration,
    });
    let received: AgentEventPayload | undefined;
    const stop = onAgentAuditEvent((event) => {
      received = event;
    });

    emitAgentAuditEvent({
      runId: attribution.runId,
      stream: "lifecycle",
      data: { phase: "start", startedAt: 1_000 },
      sessionKey: "agent:forged:event",
      sessionId: "session-forged",
      agentId: "forged",
    });
    stop();

    expect(received).toMatchObject({
      runId: attribution.runId,
      sessionKey: attribution.sessionKey,
      sessionId: attribution.sessionId,
      agentId: attribution.agentId,
    });
    expect(received?.lifecycleGeneration).toBe(getAgentEventLifecycleGeneration());
    expect(received).not.toHaveProperty("attribution");
    expect(JSON.stringify(received)).not.toContain("lifecycleGeneration");
  });

  test("does not project attribution across lifecycle generations", () => {
    const attribution = createAgentExecutionAttribution({
      runId: "run-stale-attribution",
      lifecycleGeneration: "generation-old",
      sessionKey: "agent:main:admitted",
      sessionId: "session-admitted",
      agentId: "main",
    });
    registerAgentRunContext(attribution.runId, {
      attribution,
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
    });
    let received: AgentEventPayload | undefined;
    const stop = onAgentAuditEvent((event) => {
      received = event;
    });

    emitAgentAuditEvent({
      runId: attribution.runId,
      stream: "lifecycle",
      data: { phase: "start", startedAt: 1_000 },
      sessionKey: "agent:new:event",
      sessionId: "session-new",
      agentId: "new",
    });
    stop();

    expect(received).toMatchObject({
      runId: attribution.runId,
      sessionKey: "agent:new:event",
      sessionId: "session-new",
      agentId: "new",
    });
  });

  test("delivers an owned pre-rotation retry only to the private audit bus", () => {
    const attribution = createAgentExecutionAttribution({
      runId: "run-stale-audit-retry",
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      sessionKey: "agent:main:admitted",
      sessionId: "session-admitted",
      agentId: "main",
    });
    registerAgentRunContext(attribution.runId, {
      attribution,
      lifecycleGeneration: attribution.lifecycleGeneration,
    });
    const audit: AgentEventPayload[] = [];
    const shared: AgentEventPayload[] = [];
    const stopAudit = onAgentAuditEvent((event) => audit.push(event));
    const stopShared = onAgentEvent((event) => shared.push(event));

    withAgentRunLifecycleGeneration(attribution.lifecycleGeneration, () => {
      emitAgentAuditEvent({
        runId: attribution.runId,
        stream: "lifecycle",
        data: { phase: "start", startedAt: 1_000 },
      });
    });
    rotateAgentEventLifecycleGeneration();
    withAgentRunLifecycleGeneration(attribution.lifecycleGeneration, () => {
      emitAgentAuditEvent({
        runId: attribution.runId,
        stream: "lifecycle",
        data: { phase: "start", startedAt: 1_000 },
      });
    });
    stopAudit();
    stopShared();

    expect(shared).toEqual([]);
    expect(audit.map((event) => event.seq)).toEqual([1, 2]);
    expect(audit[1]).toMatchObject({
      runId: attribution.runId,
      sessionKey: attribution.sessionKey,
      sessionId: attribution.sessionId,
      agentId: attribution.agentId,
    });
    expect(audit[1]?.lifecycleGeneration).toBe(attribution.lifecycleGeneration);
  });

  test("notifies internal projections when run contexts retire", () => {
    const retired: Array<{
      runId: string;
      lifecycleGeneration: string;
      reason: string;
    }> = [];
    const unsubscribe = onAgentRunContextRetired((event) => {
      retired.push({
        runId: event.runId,
        lifecycleGeneration: event.lifecycleGeneration,
        reason: event.reason,
      });
    });
    const firstGeneration = getAgentEventLifecycleGeneration();
    registerAgentRunContext("run-replaced", {
      sessionKey: "session-first",
      lifecycleGeneration: firstGeneration,
    });

    const secondGeneration = rotateAgentEventLifecycleGeneration();
    claimAgentRunContext("run-replaced", {
      sessionKey: "session-second",
      lifecycleGeneration: secondGeneration,
    });
    clearAgentRunContext("run-replaced", secondGeneration);

    expect(retired).toEqual([
      { runId: "run-replaced", lifecycleGeneration: firstGeneration, reason: "replaced" },
      { runId: "run-replaced", lifecycleGeneration: secondGeneration, reason: "cleared" },
    ]);
    unsubscribe();
  });
});
