import type { WorkflowStatus } from "@convex-dev/workflow";
import * as S from "effect/Schema";

import { WorkflowRunStatus } from "../../tables/workflowRuns";

export const WorkflowStatusResult = S.Struct({
  status: WorkflowRunStatus,
  componentStatus: S.optional(
    S.Literal("inProgress", "completed", "failed", "canceled"),
  ),
  result: S.optional(S.Unknown),
  error: S.optional(S.String),
  running: S.optional(S.Array(S.Unknown)),
  timeout: S.optional(
    S.Struct({
      deadlineAt: S.optional(S.NullOr(S.Number)),
      timedOutAt: S.optional(S.NullOr(S.Number)),
      errorCode: S.optional(S.NullOr(S.String)),
      summary: S.optional(S.NullOr(S.String)),
    }),
  ),
});

export type WorkflowStatusResult = S.Schema.Type<typeof WorkflowStatusResult>;

export type WorkflowStatusRunProjection = {
  readonly status?: S.Schema.Type<typeof WorkflowRunStatus>;
  readonly deadlineAt?: number | null;
  readonly timedOutAt?: number | null;
  readonly timeoutErrorCode?: string | null;
  readonly timeoutSummary?: string | null;
};

export const projectWorkflowStatus = (
  value: WorkflowStatus | null | undefined,
  run?: WorkflowStatusRunProjection | null,
): WorkflowStatusResult => {
  if (run?.status === "timedOut" || run?.timedOutAt != null) {
    return {
      status: "timedOut",
      componentStatus: value?.type,
      ...(value?.type === "completed" ? { result: value.result } : {}),
      ...(value?.type === "failed" ? { error: value.error } : {}),
      ...(value?.type === "inProgress" ? { running: value.running } : {}),
      timeout: {
        deadlineAt: run.deadlineAt,
        timedOutAt: run.timedOutAt,
        errorCode: run.timeoutErrorCode,
        summary: run.timeoutSummary,
      },
    };
  }

  if (!value) {
    return { status: run?.status ?? "queued" };
  }

  switch (value.type) {
    case "inProgress":
      return {
        status: run?.status === "queued" ? "queued" : "running",
        componentStatus: value.type,
        running: value.running,
      };
    case "completed":
      return {
        status: "completed",
        componentStatus: value.type,
        result: value.result,
      };
    case "failed":
      return {
        status: "failed",
        componentStatus: value.type,
        error: value.error,
      };
    case "canceled":
      return {
        status: "canceled",
        componentStatus: value.type,
      };
  }
};
