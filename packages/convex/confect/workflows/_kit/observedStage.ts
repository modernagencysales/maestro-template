import type { FunctionReference } from "convex/server";

import type { WorkflowNodeKind } from "../graph";

type StageMutationRef = FunctionReference<"mutation", "internal">;

export type ObservedWorkflowStageRefs = {
  readonly recordStageStarted?: StageMutationRef;
  readonly recordStageFinished?: StageMutationRef;
};

export type ObservedWorkflowStageStep = {
  readonly runMutation: (
    ref: StageMutationRef,
    args: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => Promise<unknown>;
};

export type RunObservedWorkflowStageInput<Result> = {
  readonly step: ObservedWorkflowStageStep;
  readonly refs?: ObservedWorkflowStageRefs;
  readonly workflowRunId?: string;
  readonly componentWorkflowId?: string;
  readonly nodeId: string;
  readonly label: string;
  readonly kind: WorkflowNodeKind;
  readonly stageKey?: string;
  readonly attemptNumber?: number;
  readonly order?: number;
  readonly run: () => Promise<Result>;
};

export const runObservedWorkflowStage = async <Result>(
  input: RunObservedWorkflowStageInput<Result>,
): Promise<Result> => {
  await quarantineObservation(() =>
    input.refs?.recordStageStarted
      ? input.step.runMutation(input.refs.recordStageStarted, {
          workflowRunId: input.workflowRunId,
          componentWorkflowId: input.componentWorkflowId,
          nodeId: input.nodeId,
          label: input.label,
          kind: input.kind,
          stageKey: input.stageKey ?? input.nodeId,
          attemptNumber: input.attemptNumber ?? 1,
          order: input.order,
          status: "running",
        })
      : Promise.resolve(),
  );

  try {
    const result = await input.run();
    await quarantineObservation(() =>
      input.refs?.recordStageFinished
        ? input.step.runMutation(input.refs.recordStageFinished, {
            workflowRunId: input.workflowRunId,
            componentWorkflowId: input.componentWorkflowId,
            nodeId: input.nodeId,
            label: input.label,
            kind: input.kind,
            stageKey: input.stageKey ?? input.nodeId,
            attemptNumber: input.attemptNumber ?? 1,
            order: input.order,
            status: "succeeded",
            outputJson: safeStringify(result),
          })
        : Promise.resolve(),
    );
    return result;
  } catch (error) {
    await quarantineObservation(() =>
      input.refs?.recordStageFinished
        ? input.step.runMutation(input.refs.recordStageFinished, {
            workflowRunId: input.workflowRunId,
            componentWorkflowId: input.componentWorkflowId,
            nodeId: input.nodeId,
            label: input.label,
            kind: input.kind,
            stageKey: input.stageKey ?? input.nodeId,
            attemptNumber: input.attemptNumber ?? 1,
            order: input.order,
            status: "failed",
            errorJson: safeStringify({
              message: error instanceof Error ? error.message : String(error),
            }),
          })
        : Promise.resolve(),
    );
    throw error;
  }
};

const quarantineObservation = async (
  observe: () => Promise<unknown>,
): Promise<void> => {
  try {
    await observe();
  } catch {
    // Observability must not replace the workflow's original result or failure.
  }
};

const safeStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ unserializable: true });
  }
};
