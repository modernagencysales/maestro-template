import { describe, expect, it } from "vitest";

import {
  isSafeConditionExpression,
  type DurableWorkflowGraph,
} from "../confect/workflows/graph";
import {
  runDurableGraphWorkflow,
  type DurableGraphStepRef,
  type RunDurableGraphStep,
} from "../confect/workflows/_kit/graphRunner";
import { projectWorkflowStatus } from "../confect/workflows/_kit/status";

const classifyRef =
  "internal.capabilities.classify" as unknown as DurableGraphStepRef<"query">;
const enrichRef =
  "internal.capabilities.enrich" as unknown as DurableGraphStepRef<"action">;
const stageStartedRef =
  "internal.workflows.stageStarted" as unknown as DurableGraphStepRef<"mutation">;
const stageFinishedRef =
  "internal.workflows.stageFinished" as unknown as DurableGraphStepRef<"mutation">;

const graph = {
  id: "workflow_effect_spine",
  version: 1,
  startNodeId: "source",
  nodes: [
    {
      id: "source",
      kind: "source",
      label: "Source",
      retry: { maxAttempts: 1, backoffMs: 0 },
    },
    {
      id: "classify",
      kind: "capability",
      label: "Classify",
      capability: "classifyLead",
      retry: { maxAttempts: 1, backoffMs: 0 },
    },
    {
      id: "wait",
      kind: "delay",
      label: "Delay",
      delayMs: 25,
      retry: { maxAttempts: 1, backoffMs: 0 },
    },
    {
      id: "approval",
      kind: "approval",
      label: "Approval",
      retry: { maxAttempts: 1, backoffMs: 0 },
    },
    {
      id: "enrich",
      kind: "capability",
      label: "Enrich",
      capability: "enrichLead",
      retry: { maxAttempts: 1, backoffMs: 0 },
    },
    {
      id: "output",
      kind: "output",
      label: "Output",
      retry: { maxAttempts: 1, backoffMs: 0 },
    },
  ],
  edges: [
    {
      id: "source_classify",
      sourceNodeId: "source",
      targetNodeId: "classify",
    },
    {
      id: "classify_wait",
      sourceNodeId: "classify",
      targetNodeId: "wait",
      condition: {
        expression:
          "context.classify.route === 'approved' && policySnapshot.mode !== 'blocked'",
      },
    },
    {
      id: "wait_approval",
      sourceNodeId: "wait",
      targetNodeId: "approval",
    },
    {
      id: "approval_enrich",
      sourceNodeId: "approval",
      targetNodeId: "enrich",
    },
    {
      id: "enrich_output",
      sourceNodeId: "enrich",
      targetNodeId: "output",
    },
  ],
  joins: [],
} satisfies DurableWorkflowGraph;

describe("workflow status projection", () => {
  it("projects component completion into the public workflow status", () => {
    expect(
      projectWorkflowStatus({
        type: "completed",
        result: { ok: true },
      }),
    ).toEqual({
      status: "completed",
      componentStatus: "completed",
      result: { ok: true },
    });
  });

  it("lets timeout rows override a still-running component status", () => {
    expect(
      projectWorkflowStatus(
        {
          type: "inProgress",
          running: [{ name: "wait" }],
        } as never,
        {
          status: "timedOut",
          deadlineAt: 100,
          timedOutAt: 125,
          timeoutErrorCode: "WORKFLOW_TIMEOUT",
          timeoutSummary: "Approval deadline elapsed.",
        },
      ),
    ).toEqual({
      status: "timedOut",
      componentStatus: "inProgress",
      running: [{ name: "wait" }],
      timeout: {
        deadlineAt: 100,
        timedOutAt: 125,
        errorCode: "WORKFLOW_TIMEOUT",
        summary: "Approval deadline elapsed.",
      },
    });
  });
});

describe("workflow condition grammar", () => {
  it("accepts only the durable safe expression subset", () => {
    const allowed = [
      "inputs.kind === 'lead'",
      "context.classify.score !== 0",
      "policySnapshot.mode === 'dryRun' || context.review.status === 'ready'",
      "!(context.review.status === 'blocked')",
      "(inputs.score === 3 && policySnapshot.version !== 1)",
    ];

    for (const expression of allowed) {
      expect(isSafeConditionExpression(expression), expression).toBe(true);
    }
  });

  it("rejects globals, calls, writes, constructors, regex, import, and loose equality", () => {
    const rejected = [
      "globalThis.process.exit()",
      "inputs.kind == 'lead'",
      "inputs.kind = 'lead'",
      "context.review.status = 'ready'",
      "context.review.status() === 'ready'",
      "context.constructor.name === 'Object'",
      "/ready/.test(context.review.status)",
      "import('node:fs')",
    ];

    for (const expression of rejected) {
      expect(isSafeConditionExpression(expression), expression).toBe(false);
    }
  });
});

describe("durable graph runner", () => {
  it("dispatches through the registry, sleeps, awaits approval, and observes stages", async () => {
    const queryCalls: unknown[] = [];
    const actionCalls: unknown[] = [];
    const mutationCalls: Array<{
      readonly ref: DurableGraphStepRef<"mutation">;
      readonly args: Record<string, unknown>;
    }> = [];
    const sleeps: Array<{
      readonly delayMs: number;
      readonly name: string | undefined;
    }> = [];
    const events: string[] = [];

    const step: RunDurableGraphStep = {
      runQuery: async (ref, args) => {
        queryCalls.push({ ref, args });
        return { route: "approved", refDispatched: ref === classifyRef };
      },
      runAction: async (ref, args) => {
        actionCalls.push({ ref, args });
        return { enriched: true, refDispatched: ref === enrichRef };
      },
      runMutation: async (ref, args) => {
        mutationCalls.push({ ref, args });
        return null;
      },
      sleep: async (delayMs, options) => {
        sleeps.push({ delayMs, name: options?.name });
      },
      awaitEvent: async <Result>(event: { readonly name: string }) => {
        events.push(event.name);
        return { approvedBy: "user_123" } as Result;
      },
    };

    const result = await runDurableGraphWorkflow(step, {
      graph,
      inputs: { kind: "lead", email: "founder@example.test" },
      policySnapshot: { mode: "review", version: 2 },
      capabilityRegistry: {
        classifyLead: {
          kind: "query",
          ref: classifyRef,
        },
        enrichLead: {
          kind: "action",
          ref: enrichRef,
        },
      },
      observability: {
        workflowRunId: "run_123",
        componentWorkflowId: "workflow_component_123",
        recordStageStarted: stageStartedRef,
        recordStageFinished: stageFinishedRef,
      },
      projectOutput: ({ context }) => ({
        classify: context.classify,
        enrich: context.enrich,
        approval: context.approval,
        delay: context.wait,
      }),
    });

    expect(result).toEqual({
      classify: { route: "approved", refDispatched: true },
      enrich: { enriched: true, refDispatched: true },
      approval: { approvedBy: "user_123" },
      delay: { delayedMs: 25 },
    });
    expect(queryCalls).toHaveLength(1);
    expect(actionCalls).toHaveLength(1);
    expect(sleeps).toEqual([
      { delayMs: 25, name: "workflow_effect_spine.wait.delay" },
    ]);
    expect(events).toEqual(["workflow_effect_spine.approval.approved"]);
    expect(
      mutationCalls.filter((call) => call.ref === stageStartedRef),
    ).toHaveLength(graph.nodes.length);
    expect(
      mutationCalls.filter((call) => call.ref === stageFinishedRef),
    ).toHaveLength(graph.nodes.length);
  });
});
