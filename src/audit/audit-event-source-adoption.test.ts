import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { recordAuditEvent } from "./audit-event-store.js";
import type { AuditEventInput } from "./audit-event-types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createDatabaseOptions() {
  return { env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-audit-adoption-") } };
}

function auditInput(overrides: Partial<AuditEventInput> = {}): AuditEventInput {
  const input = {
    sourceSequence: 1,
    occurredAt: Date.now(),
    kind: "agent_run",
    action: "agent.run.started",
    status: "started",
    actorType: "agent",
    actorId: "main",
    agentId: "main",
    sessionKey: "agent:main:main",
    sessionId: "session-1",
    runId: "run-1",
    ...overrides,
  };
  return {
    ...input,
    sourceId:
      overrides.sourceId ??
      `${input.runId}:${input.sourceSequence}:${input.occurredAt}:${input.action}`,
  } as AuditEventInput;
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("audit event source adoption", () => {
  it("adopts one equivalent generation-aware replay against a shipped legacy source key", () => {
    const database = createDatabaseOptions();
    const occurredAt = Date.now();
    const legacySourceId = `run-legacy:1:${occurredAt}:agent.run.started`;
    expect(
      recordAuditEvent(
        auditInput({ sourceId: legacySourceId, sourceSequence: 1, occurredAt }),
        database,
      ),
    ).toBeDefined();
    const { db: legacyDb } = openOpenClawStateDatabase(database);
    legacyDb.exec("DROP TABLE audit_event_source_adoptions");
    closeOpenClawStateDatabaseForTest();

    expect(
      recordAuditEvent(
        auditInput({
          sourceId: `lifecycle:generation-1:${legacySourceId}`,
          legacySourceId,
          sourceSequence: 1,
          occurredAt,
        }),
        database,
      ),
    ).toBeUndefined();
    expect(
      recordAuditEvent(
        auditInput({
          sourceId: `lifecycle:generation-1:${legacySourceId}`,
          legacySourceId,
          sourceSequence: 1,
          occurredAt,
        }),
        database,
      ),
    ).toBeUndefined();
    closeOpenClawStateDatabaseForTest();
    expect(
      recordAuditEvent(
        auditInput({
          sourceId: `lifecycle:generation-2:${legacySourceId}`,
          legacySourceId,
          sourceSequence: 1,
          occurredAt,
        }),
        database,
      ),
    ).toBeDefined();

    const { db } = openOpenClawStateDatabase(database);
    expect(
      db
        .prepare("SELECT source_id FROM audit_events ORDER BY sequence")
        .all()
        .map((row) => (row as { source_id: string }).source_id),
    ).toEqual([legacySourceId, `lifecycle:generation-2:${legacySourceId}`]);
    expect(db.prepare("SELECT * FROM audit_event_source_adoptions").all()).toEqual([
      {
        legacy_source_id: legacySourceId,
        adopted_source_id: `lifecycle:generation-1:${legacySourceId}`,
      },
    ]);
  });
});
