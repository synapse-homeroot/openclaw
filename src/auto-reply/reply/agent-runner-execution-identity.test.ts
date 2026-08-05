import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureExecutionIdentityAdmissionSink,
  type ExecutionIdentityAdmissionWork,
} from "../../audit/execution-identity-admission.js";
import { admitAutoReplyExecutionAttribution } from "./agent-runner-execution-identity.js";

describe("admitAutoReplyExecutionAttribution", () => {
  let restoreSink: (() => void) | undefined;

  afterEach(() => {
    restoreSink?.();
    restoreSink = undefined;
  });

  it("records exact channel and requester evidence with the runtime attribution token", () => {
    const work: ExecutionIdentityAdmissionWork[] = [];
    restoreSink = configureExecutionIdentityAdmissionSink((item) => {
      work.push(item);
      return true;
    });

    const attribution = admitAutoReplyExecutionAttribution({
      config: { logging: { audit: { enabled: true, executionIdentity: true } } },
      lifecycleGeneration: "generation-1",
      runId: "run-1",
      context: {
        accountId: "workspace-1",
        agentId: "main",
        channel: "slack",
        chatId: "C123",
        messageId: "M456",
        senderId: "U789",
        senderLabel: "Operator",
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        threadId: "T123",
        isHeartbeat: false,
      },
    });

    expect(work).toHaveLength(1);
    expect(work[0]).toMatchObject({
      kind: "capture",
      envelope: {
        contextId: attribution.contextId,
        executionId: attribution.executionId,
        runId: "run-1",
        ingress: { kind: "channel", boundary: "auto-reply.channel" },
        invoker: { kind: "person", displayLabel: "Operator" },
        runtime: { kind: "embedded" },
      },
    });
  });

  it("does not persist or replace an already admitted attribution", () => {
    const sink = vi.fn(() => true);
    restoreSink = configureExecutionIdentityAdmissionSink(sink);
    const attribution = admitAutoReplyExecutionAttribution({
      config: {},
      lifecycleGeneration: "generation-1",
      runId: "run-1",
      context: { isHeartbeat: false },
    });

    expect(
      admitAutoReplyExecutionAttribution({
        attribution,
        config: { logging: { audit: { enabled: true, executionIdentity: true } } },
        lifecycleGeneration: "generation-2",
        runId: "run-1",
        context: { isHeartbeat: false },
      }),
    ).toBe(attribution);
    expect(sink).not.toHaveBeenCalled();
  });
});
