import { describe, expect, it } from "vitest";
import { createExecutionIdentityAdmissionToken } from "../audit/execution-identity-admission.js";
import { createAgentExecutionAttribution } from "./agent-execution-attribution.js";

describe("createAgentExecutionAttribution", () => {
  it("preserves required identities, normalizes optional correlation, and freezes the record", () => {
    const token = createExecutionIdentityAdmissionToken(" run-1 ", {
      contextId: "context-1",
      executionId: "execution-1",
      now: 123,
    });
    const attribution = createAgentExecutionAttribution({
      runId: " run-1 ",
      lifecycleGeneration: " generation-1 ",
      sessionKey: " agent:main:main ",
      sessionId: " session-1 ",
      agentId: " main ",
      executionIdentityAdmission: { token, retryOnly: true },
    });

    expect(attribution).toEqual({
      runId: " run-1 ",
      contextId: "context-1",
      executionId: "execution-1",
      createdAt: 123,
      lifecycleGeneration: " generation-1 ",
      executionIdentityAdmission: { token, retryOnly: true },
      sessionKey: "agent:main:main",
      sessionId: "session-1",
      agentId: "main",
    });
    expect(Object.isFrozen(attribution)).toBe(true);
    expect(Reflect.set(attribution, "sessionId", "replacement")).toBe(false);
  });

  it("leaves unknown optional correlation absent", () => {
    const attribution = createAgentExecutionAttribution({
      runId: "run-1",
      lifecycleGeneration: "generation-1",
      sessionKey: " ",
      sessionId: "",
    });
    expect(attribution).toMatchObject({
      runId: "run-1",
      lifecycleGeneration: "generation-1",
    });
    expect(attribution).not.toHaveProperty("sessionKey");
    expect(attribution).not.toHaveProperty("sessionId");
    expect(attribution.executionIdentityAdmission.retryOnly).toBe(false);
  });

  it.each([
    ["runId", { runId: " ", lifecycleGeneration: "generation-1" }],
    ["lifecycleGeneration", { runId: "run-1", lifecycleGeneration: "" }],
  ])("rejects a missing required %s", (field, params) => {
    expect(() => createAgentExecutionAttribution(params)).toThrow(
      `Agent execution attribution requires ${field}`,
    );
  });

  it("rejects an admission token owned by another run", () => {
    expect(() =>
      createAgentExecutionAttribution({
        runId: "run-1",
        lifecycleGeneration: "generation-1",
        executionIdentityAdmission: {
          token: createExecutionIdentityAdmissionToken("run-2"),
          retryOnly: false,
        },
      }),
    ).toThrow("Agent execution attribution token disagrees with runId");
  });
});
