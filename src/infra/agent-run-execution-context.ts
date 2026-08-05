import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

const AGENT_RUN_EXECUTION_CONTEXT_KEY = Symbol.for("openclaw.agentRunExecutionContext");

type AgentRunExecutionContext = {
  lifecycleGeneration: string;
  onceByRun: Map<string, Promise<unknown>>;
};

function getAgentRunExecutionContext() {
  return resolveGlobalSingleton<AsyncLocalStorage<AgentRunExecutionContext>>(
    AGENT_RUN_EXECUTION_CONTEXT_KEY,
    () => new AsyncLocalStorage<AgentRunExecutionContext>(),
  );
}

export function getAgentRunExecutionLifecycleGeneration(): string | undefined {
  return getAgentRunExecutionContext().getStore()?.lifecycleGeneration;
}

/** Runs one execution with immutable ownership inherited by every emitted event. */
export function withAgentRunLifecycleGeneration<T>(lifecycleGeneration: string, run: () => T): T {
  const storage = getAgentRunExecutionContext();
  const parent = storage.getStore();
  const onceByRun =
    parent?.lifecycleGeneration === lifecycleGeneration ? parent.onceByRun : new Map();
  return storage.run({ lifecycleGeneration, onceByRun }, run);
}

/** Shares one operation across fallback attempts that belong to the same admitted run. */
export function runOncePerAgentRun<T>(runId: string, operation: string, run: () => Promise<T>) {
  const context = getAgentRunExecutionContext().getStore();
  if (!context) {
    return run();
  }
  const key = `${operation}:${runId}`;
  const existing = context.onceByRun.get(key);
  if (existing) {
    return existing as Promise<T>;
  }
  const pending = Promise.resolve().then(run);
  context.onceByRun.set(key, pending);
  return pending;
}
