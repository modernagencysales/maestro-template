import { FunctionImpl, GroupImpl } from "@confect/server";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import databaseSchema from "../_generated/schema";
import { DatabaseReader, DatabaseWriter } from "../_generated/services";
import { requireWorkspaceAccess } from "../capabilities/_kit/workspaceAccess";
import pages from "./pages.spec";

const withConfectClock = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Exclude<R, Clock.Clock>> =>
  // Confect provides Clock at runtime, but its current handler type omits it.
  effect as Effect.Effect<A, E, Exclude<R, Clock.Clock>>;

const list = FunctionImpl.make(
  databaseSchema,
  pages,
  "list",
  ({ workspaceId }) =>
    Effect.gen(function* () {
      yield* withConfectClock(requireWorkspaceAccess(workspaceId, "viewer"));
      const reader = yield* DatabaseReader;
      return yield* reader
        .table("brainPages")
        .index("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .collect()
        .pipe(Effect.orDie);
    }),
);

const createMarkdown = FunctionImpl.make(
  databaseSchema,
  pages,
  "createMarkdown",
  ({ workspaceId, slug, title, markdown }) =>
    Effect.gen(function* () {
      yield* withConfectClock(requireWorkspaceAccess(workspaceId, "editor"));
      const updatedAt = yield* withConfectClock(Clock.currentTimeMillis);
      const writer = yield* DatabaseWriter;
      return yield* writer
        .table("brainPages")
        .insert({
          workspaceId,
          slug,
          title,
          markdown,
          sourceKind: "markdown",
          updatedAt,
        })
        .pipe(Effect.orDie);
    }),
);

export default GroupImpl.make(databaseSchema, pages).pipe(
  Layer.provide(list),
  Layer.provide(createMarkdown),
  GroupImpl.finalize,
);
