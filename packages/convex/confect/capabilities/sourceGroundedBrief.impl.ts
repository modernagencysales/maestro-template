import type { GenericId } from "convex/values";
import { FunctionImpl, GroupImpl } from "@confect/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import databaseSchema from "../_generated/schema";
import { unsafeAssumeClockProvided } from "../shared/clock";
import { requireWorkspaceAccess } from "./_kit/workspaceAccess";
import { runFakeSourceGroundedBrief } from "./sourceGroundedBrief.fake";
import { normalizeSourceGroundedBriefInput } from "./sourceGroundedBrief.domain";
import type { SourceGroundedBriefInput } from "./sourceGroundedBrief.domain";
import sourceGroundedBrief from "./sourceGroundedBrief.spec";

const runSourceGroundedBrief = (input: SourceGroundedBriefInput) =>
  Effect.gen(function* () {
    yield* unsafeAssumeClockProvided(
      requireWorkspaceAccess(
        input.workspaceId as GenericId<"workspaces">,
        "editor",
      ),
    );

    const normalized = normalizeSourceGroundedBriefInput(input);
    if (normalized instanceof Error) {
      return yield* Effect.fail(normalized);
    }

    return runFakeSourceGroundedBrief({
      input: normalized,
      sources: normalized.sourceIds.map((sourceId) => ({
        id: sourceId,
        title: `Source ${sourceId}`,
        markdown: "Synthetic source content for fake-mode capability run.",
      })),
      policySnapshotId: `policy_snapshot_${normalized.idempotencyKey}`,
      modelReceiptId: `model_receipt_${normalized.idempotencyKey}`,
    });
  });

const run = FunctionImpl.make(
  databaseSchema,
  sourceGroundedBrief,
  "run",
  runSourceGroundedBrief,
);

const runInternal = FunctionImpl.make(
  databaseSchema,
  sourceGroundedBrief,
  "runInternal",
  runSourceGroundedBrief,
);

export default GroupImpl.make(databaseSchema, sourceGroundedBrief).pipe(
  Layer.provide(run),
  Layer.provide(runInternal),
  GroupImpl.finalize,
);
