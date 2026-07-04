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
  await recordStageStarted(input);

  try {
    const result = await input.run();
    await recordStageSucceeded(input, result);
    return result;
  } catch (error) {
    await recordStageFailed(input, error);
    throw error;
  }
};

const recordStageStarted = <Result>(
  input: RunObservedWorkflowStageInput<Result>,
): Promise<void> =>
  quarantineObservation(() =>
    input.refs?.recordStageStarted
      ? input.step.runMutation(input.refs.recordStageStarted, {
          ...stageObservationArgs(input),
          status: "running",
        })
      : Promise.resolve(),
  );

const recordStageSucceeded = <Result>(
  input: RunObservedWorkflowStageInput<Result>,
  result: Result,
): Promise<void> =>
  quarantineObservation(() =>
    input.refs?.recordStageFinished
      ? input.step.runMutation(input.refs.recordStageFinished, {
          ...stageObservationArgs(input),
          status: "succeeded",
          outputJson: safeStringify(result),
        })
      : Promise.resolve(),
  );

const recordStageFailed = <Result>(
  input: RunObservedWorkflowStageInput<Result>,
  error: unknown,
): Promise<void> =>
  quarantineObservation(() =>
    input.refs?.recordStageFinished
      ? input.step.runMutation(input.refs.recordStageFinished, {
          ...stageObservationArgs(input),
          status: "failed",
          errorJson: safeStringify({ message: errorMessage(error) }),
        })
      : Promise.resolve(),
  );

const stageObservationArgs = <Result>(
  input: RunObservedWorkflowStageInput<Result>,
): Record<string, unknown> => ({
  workflowRunId: input.workflowRunId,
  componentWorkflowId: input.componentWorkflowId,
  nodeId: input.nodeId,
  label: input.label,
  kind: input.kind,
  stageKey: input.stageKey ?? input.nodeId,
  attemptNumber: input.attemptNumber ?? 1,
  order: input.order,
});

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

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
