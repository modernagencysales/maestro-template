import { FunctionImpl, GroupImpl } from "@confect/server";
import type { GenericId } from "convex/values";
import * as Clock from "effect/Clock";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import databaseSchema from "../_generated/schema";
import { Auth, DatabaseReader, DatabaseWriter } from "../_generated/services";
import { Unauthorized } from "../errors";
import { asGenericId, type Reader } from "./handlerContext";
import provisioning from "./provisioning.spec";
import {
  buildProvisioningPlan,
  extractIdentityProfile,
  requireInsertValue,
  selectLiveOwnedOrganization,
  selectLiveOwnedWorkspace,
  type IdentityProfile,
  type OrganizationProvisioningRow,
  type RowPlan,
  type UserProvisioningRow,
} from "./provisioning";

type Writer = Context.Tag.Service<typeof DatabaseWriter>;

const ensureProvisioned = FunctionImpl.make(
  databaseSchema,
  provisioning,
  "ensureProvisioned",
  () =>
    Effect.gen(function* () {
      const auth = yield* Auth;
      const identity = yield* extractIdentityProfile(
        yield* auth.getUserIdentity.pipe(
          Effect.mapError(() => new Unauthorized()),
        ),
      );
      const now = yield* Clock.currentTimeMillis;

      const reader = yield* DatabaseReader;
      const writer = yield* DatabaseWriter;

      const existingUser = yield* loadExistingUser(reader, identity.subject);
      const userId = yield* ensureUserRow(writer, identity, existingUser, now);

      const existingOrganization = yield* loadOwnedOrganization(reader, userId);
      const existingWorkspace = yield* loadOwnedWorkspace(
        reader,
        existingOrganization,
        userId,
      );
      const organizationMembership =
        existingOrganization === null
          ? null
          : yield* reader
              .table("organizationMembers")
              .index("by_organization_user", (q) =>
                q
                  .eq("organizationId", existingOrganization._id)
                  .eq("userId", userId),
              )
              .first()
              .pipe(Effect.map(Option.getOrNull), Effect.orDie);

      const workspaceMembership =
        existingWorkspace === null
          ? null
          : yield* reader
              .table("workspaceMembers")
              .index("by_workspace_user", (q) =>
                q.eq("workspaceId", existingWorkspace._id).eq("userId", userId),
              )
              .first()
              .pipe(Effect.map(Option.getOrNull), Effect.orDie);

      const plan = yield* buildProvisioningPlan({
        identity,
        state: {
          user: existingUser,
          liveOrganization: existingOrganization,
          liveWorkspace: existingWorkspace,
          organizationMembership,
          workspaceMembership,
        },
        now,
      });

      const organizationId = yield* ensureOwnedRow(
        writer,
        "organizations",
        plan.organization,
        existingOrganization,
        { ownerUserId: userId },
      );
      const workspaceId = yield* ensureOwnedRow(
        writer,
        "workspaces",
        plan.workspace,
        existingWorkspace,
        { organizationId, ownerUserId: userId },
      );

      yield* upsertMembership(
        writer,
        "organizationMembers",
        organizationMembership?._id ?? null,
        plan.organizationMembership,
        () => ({
          ...requireInsertValue(
            plan.organizationMembership,
            "organizationMembership",
          ),
          organizationId,
          userId,
        }),
      );
      yield* upsertMembership(
        writer,
        "workspaceMembers",
        workspaceMembership?._id ?? null,
        plan.workspaceMembership,
        () => ({
          ...requireInsertValue(
            plan.workspaceMembership,
            "workspaceMembership",
          ),
          workspaceId,
          userId,
        }),
      );

      return { workspaceId };
    }),
);

/** Load the caller's existing `users` row, if any, keyed by provider subject. */
const loadExistingUser = (reader: Reader, subject: string) =>
  reader
    .table("users")
    .index("by_subject", (q) => q.eq("subject", subject))
    .first()
    .pipe(
      Effect.map(Option.getOrNull),
      Effect.map((user) => (user === null ? null : toProvisioningUser(user))),
      Effect.orDie,
    );

/** Provision (insert or patch) the caller's `users` row, returning its id. */
const ensureUserRow = (
  writer: Writer,
  identity: IdentityProfile,
  existingUser: UserProvisioningRow | null,
  now: number,
) =>
  Effect.gen(function* () {
    const userPlan = (yield* buildProvisioningPlan({
      identity,
      state: {
        user: existingUser,
        liveOrganization: null,
        liveWorkspace: null,
        organizationMembership: null,
        workspaceMembership: null,
      },
      now,
    })).user;

    if (existingUser === null) {
      return yield* writer
        .table("users")
        .insert(requireInsertValue(userPlan, "user"))
        .pipe(Effect.orDie);
    }

    if (userPlan.action === "patch") {
      yield* writer
        .table("users")
        .patch(asGenericId<"users">(existingUser._id), userPlan.value)
        .pipe(Effect.orDie);
    }
    return asGenericId<"users">(existingUser._id);
  });

/** Load the single live organization owned by the user, if any. */
const loadOwnedOrganization = (reader: Reader, userId: GenericId<"users">) =>
  Effect.gen(function* () {
    const organizations = yield* reader
      .table("organizations")
      .index("by_owner", (q) => q.eq("ownerUserId", userId))
      .take(100)
      .pipe(Effect.orDie);
    return yield* selectLiveOwnedOrganization(organizations, userId);
  });

/** Load the single live workspace owned by the user, if any. */
const loadOwnedWorkspace = (
  reader: Reader,
  existingOrganization: OrganizationProvisioningRow | null,
  userId: GenericId<"users">,
) =>
  Effect.gen(function* () {
    const workspaces =
      existingOrganization === null
        ? []
        : yield* reader
            .table("workspaces")
            .index("by_organization", (q) =>
              q.eq("organizationId", existingOrganization._id),
            )
            .take(100)
            .pipe(Effect.orDie);
    return yield* selectLiveOwnedWorkspace(workspaces, userId);
  });

/**
 * Insert an owned tenant row when absent (returning its id), or reuse the
 * existing id. The plan value plus `extras` are the table's row shape by
 * construction; the per-table Convex writer generic cannot verify that across
 * the `organizations`/`workspaces` pair, so the value is asserted at this single
 * boundary — the same localized cast as {@link asGenericId}.
 */
const ensureOwnedRow = <Table extends "organizations" | "workspaces">(
  writer: Writer,
  table: Table,
  plan: RowPlan<Record<string, unknown>>,
  existing: { readonly _id: string } | null,
  extras: Record<string, unknown>,
): Effect.Effect<GenericId<Table>, never> =>
  existing === null
    ? writer
        .table(table)
        .insert({ ...requireInsertValue(plan, "row"), ...extras } as never)
        .pipe(Effect.orDie)
    : Effect.succeed(asGenericId<Table>(existing._id));

/**
 * Insert a membership row when absent, patch it when the plan says so, else
 * no-op. `buildInsert` is thunked so its `requireInsertValue` assertion only
 * runs on the insert path. The row/patch values are asserted at this single
 * Convex boundary because the membership tables share an upsert shape but are
 * distinct tables (same localized cast as {@link asGenericId}).
 */
const upsertMembership = (
  writer: Writer,
  table: "organizationMembers" | "workspaceMembers",
  existingId: string | null,
  plan: RowPlan<Record<string, unknown>>,
  buildInsert: () => Record<string, unknown>,
): Effect.Effect<unknown, never> => {
  if (existingId === null) {
    return writer
      .table(table)
      .insert(buildInsert() as never)
      .pipe(Effect.orDie);
  }
  if (plan.action === "patch") {
    return writer
      .table(table)
      .patch(asGenericId(existingId), plan.value as never)
      .pipe(Effect.orDie);
  }
  return Effect.void;
};

const toProvisioningUser = (user: {
  readonly _id: GenericId<"users">;
  readonly subject: string;
  readonly email: string;
  readonly displayName?: string | undefined;
  readonly status: "active" | "suspended" | "deleted";
  readonly createdAt: number;
  readonly updatedAt: number;
}): UserProvisioningRow => ({
  _id: user._id,
  subject: user.subject,
  email: user.email,
  ...(user.displayName === undefined ? {} : { displayName: user.displayName }),
  status: user.status,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
});

export default GroupImpl.make(databaseSchema, provisioning).pipe(
  Layer.provide(ensureProvisioned),
  GroupImpl.finalize,
);
