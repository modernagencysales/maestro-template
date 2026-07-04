import { start, type WorkflowId } from "@convex-dev/workflow";
import type { FunctionArgs, FunctionReference } from "convex/server";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  DatabaseReader,
  DatabaseWriter,
  MutationCtx,
} from "../../_generated/services";
import { makePublicError } from "../../shared/errors";

export type StartWorkflowOwnershipInput<
  F extends FunctionReference<"mutation", "internal">,
> = {
  readonly workflowRef: F;
  readonly workflowArgs: FunctionArgs<F>["args"];
  readonly workspaceId: string;
  readonly workflowId: string;
  readonly workflowVersion: number;
  readonly graphJson: string;
  readonly idempotencyKey: string;
  readonly startedByUserId: string;
  readonly startedAt: number;
  readonly trustReceiptId?: string | null;
  readonly workflowKind?: string;
  readonly sourceRunKind?: string;
  readonly sourceRunId?: string;
  readonly timeoutMs?: number;
  readonly deadlineAt?: number;
};

export const startWorkflowAndRecordOwnership = <
  F extends FunctionReference<"mutation", "internal">,
>(
  input: StartWorkflowOwnershipInput<F>,
): Effect.Effect<
  WorkflowId,
  unknown,
  MutationCtx | DatabaseReader | DatabaseWriter
> =>
  Effect.gen(function* () {
    const reader = yield* DatabaseReader;
    const writer = yield* DatabaseWriter;
    const mutationCtx = yield* MutationCtx;

    const existing = yield* reader
      .table("workflowRuns")
      .index("by_idempotency_key", (q) =>
        q
          .eq("workspaceId", input.workspaceId)
          .eq("idempotencyKey", input.idempotencyKey),
      )
      .first()
      .pipe(Effect.map(Option.getOrNull), Effect.orDie);

    if (existing?.componentWorkflowId) {
      return existing.componentWorkflowId as WorkflowId;
    }

    if (existing) {
      return yield* Effect.fail(
        makePublicError(
          "VALIDATION_FAILED",
          "Workflow start is already reserved for this idempotency key.",
          { idempotencyKey: input.idempotencyKey },
        ),
      );
    }

    const reservationId = yield* writer
      .table("workflowRuns")
      .insert({
        workspaceId: input.workspaceId,
        workflowId: input.workflowId,
        workflowVersion: input.workflowVersion,
        graphJson: input.graphJson,
        status: "queued",
        idempotencyKey: input.idempotencyKey,
        startedByUserId: input.startedByUserId,
        startedAt: input.startedAt,
        completedAt: null,
        failedAt: null,
        trustReceiptId: input.trustReceiptId ?? null,
        ...(input.workflowKind ? { workflowKind: input.workflowKind } : {}),
        ...(input.sourceRunKind ? { sourceRunKind: input.sourceRunKind } : {}),
        ...(input.sourceRunId ? { sourceRunId: input.sourceRunId } : {}),
        ...(input.timeoutMs !== undefined
          ? { timeoutMs: input.timeoutMs }
          : {}),
        ...(input.deadlineAt !== undefined
          ? { deadlineAt: input.deadlineAt }
          : {}),
      })
      .pipe(Effect.orDie);

    const componentWorkflowId = yield* Effect.promise(() =>
      start(mutationCtx, input.workflowRef, input.workflowArgs, {
        startAsync: true,
      }),
    );

    yield* writer
      .table("workflowRuns")
      .patch(reservationId, {
        status: "running",
        componentWorkflowId,
      })
      .pipe(Effect.orDie);

    return componentWorkflowId;
  });
