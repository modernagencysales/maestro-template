import { GroupSpec } from "@confect/core";
import * as S from "effect/Schema";
import { internalMutationStep, publicMutation } from "./_kit/capability";

export const SourceGroundedBriefArgs = S.Struct({
  workspaceId: S.String,
  sourceIds: S.Array(S.String).pipe(S.minItems(1)),
  briefGoal: S.String.pipe(S.minLength(1)),
  idempotencyKey: S.String.pipe(S.minLength(1)),
});

export const SourceGroundedBriefReturn = S.Struct({
  briefMarkdown: S.String,
  sourceTitles: S.Array(S.String),
  policySnapshotId: S.String,
  modelReceiptId: S.String,
  trustClaim: S.String,
});

const run = publicMutation({
  name: "run",
  args: () => SourceGroundedBriefArgs,
  returns: () => SourceGroundedBriefReturn,
});

const runInternal = internalMutationStep({
  name: "runInternal",
  args: () => SourceGroundedBriefArgs,
  returns: () => SourceGroundedBriefReturn,
});

export default GroupSpec.make().addFunction(run).addFunction(runInternal);
