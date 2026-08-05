import { describe, expect, it } from "vitest";
import { executionIdentity } from "./agent-command-execution-identity.js";
import { createAgentExecutionAttribution } from "./agent-execution-attribution.js";

describe("agent command execution identity", () => {
  it("uses exact attribution as the lifecycle authority", () => {
    const attribution = createAgentExecutionAttribution({
      runId: "run-1",
      lifecycleGeneration: "generation-attribution",
    });

    expect(
      executionIdentity.resolveAttribution(
        {
          executionAttribution: attribution,
          lifecycleGeneration: "generation-flat",
        } as never,
        attribution.runId,
      ),
    ).toEqual({
      attribution,
      lifecycleGeneration: "generation-attribution",
    });
  });

  it("rejects attribution captured for a different run", () => {
    const attribution = createAgentExecutionAttribution({
      runId: "run-attribution",
      lifecycleGeneration: "generation-attribution",
    });

    expect(() =>
      executionIdentity.resolveAttribution(
        {
          executionAttribution: attribution,
        } as never,
        "run-command",
      ),
    ).toThrow("Agent command execution attribution runId does not match the command runId.");
  });

  it("replaces attribution only after lifecycle rebound", () => {
    const attribution = createAgentExecutionAttribution({
      runId: "run-1",
      lifecycleGeneration: "generation-1",
    });
    const opts = { executionAttribution: attribution } as never;

    expect(executionIdentity.replaceAttribution(opts, attribution)).toBe(opts);
    expect(
      executionIdentity.replaceAttribution(
        opts,
        createAgentExecutionAttribution({
          ...attribution,
          lifecycleGeneration: "generation-2",
          executionIdentityAdmission: attribution.executionIdentityAdmission,
        }),
      ),
    ).not.toBe(opts);
  });

  it("strips untrusted ingress attribution and preserves trusted gateway attribution", () => {
    const attribution = createAgentExecutionAttribution({
      runId: "run-1",
      lifecycleGeneration: "generation-1",
    });
    const opts = {
      allowModelOverride: false,
      executionAttribution: attribution,
      lifecycleGeneration: "generation-flat",
      runId: attribution.runId,
    } as never;

    expect(executionIdentity.prepareIngress(opts, false)).toEqual({
      lifecycleGeneration: "generation-flat",
      opts: {
        allowModelOverride: false,
        lifecycleGeneration: "generation-flat",
        runId: attribution.runId,
      },
    });
    expect(executionIdentity.prepareIngress(opts, true)).toEqual({
      lifecycleGeneration: "generation-flat",
      opts,
    });
  });
});
