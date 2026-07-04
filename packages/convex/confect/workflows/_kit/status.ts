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

type ComponentWorkflowStatusBlob = {
  readonly type?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
  readonly running?: unknown[];
};

const isKnownComponentStatus = (
  status: unknown,
): status is NonNullable<WorkflowStatusResult["componentStatus"]> =>
  status === "inProgress" ||
  status === "completed" ||
  status === "failed" ||
  status === "canceled";

export const projectWorkflowStatus = (
  value: WorkflowStatus | null | undefined,
  run?: WorkflowStatusRunProjection | null,
): WorkflowStatusResult => {
  const component = value as ComponentWorkflowStatusBlob | null | undefined;
  const componentStatus = component?.type;

  if (run?.status === "timedOut" || run?.timedOutAt != null) {
    return {
      status: "timedOut",
      ...(isKnownComponentStatus(componentStatus) ? { componentStatus } : {}),
      ...(componentStatus === "completed" ? { result: component?.result } : {}),
      ...(componentStatus === "failed" && typeof component?.error === "string"
        ? { error: component.error }
        : {}),
      ...(componentStatus === "inProgress" && Array.isArray(component?.running)
        ? { running: component.running }
        : {}),
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

  const presentComponent = value as ComponentWorkflowStatusBlob;
  const presentComponentStatus = presentComponent.type;

  switch (presentComponentStatus) {
    case "inProgress":
      return {
        status: run?.status === "queued" ? "queued" : "running",
        componentStatus: presentComponentStatus,
        running: Array.isArray(presentComponent.running)
          ? presentComponent.running
          : [],
      };
    case "completed":
      return {
        status: "completed",
        componentStatus: presentComponentStatus,
        result: presentComponent.result,
      };
    case "failed":
      return {
        status: "failed",
        componentStatus: presentComponentStatus,
        error:
          typeof presentComponent.error === "string"
            ? presentComponent.error
            : "",
      };
    case "canceled":
      return {
        status: "canceled",
        componentStatus: presentComponentStatus,
      };
    default:
      return { status: run?.status ?? "queued" };
  }
};
