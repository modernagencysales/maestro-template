import { FunctionImpl, GroupImpl } from "@confect/server";
import type { GenericId } from "convex/values";
import type * as Context from "effect/Context";
import * as Clock from "effect/Clock";
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
  type OrganizationMembershipProvisioningRow,
  type OrganizationProvisioningRow,
  type ProvisioningPlan,
  type UserProvisioningRow,
  type WorkspaceMembershipProvisioningRow,
  type WorkspaceProvisioningRow,
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

      const organizations = yield* reader
        .table("organizations")
        .index("by_owner", (q) => q.eq("ownerUserId", userId))
        .take(100)
        .pipe(Effect.orDie);
      const existingOrganization = yield* selectLiveOwnedOrganization(
        organizations,
        userId,
      );

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
      const existingWorkspace = yield* selectLiveOwnedWorkspace(
        workspaces,
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

      const organizationId = yield* ensureOrganizationRow(
        writer,
        plan,
        existingOrganization,
        userId,
      );

      const workspaceId = yield* ensureWorkspaceRow(
        writer,
        plan,
        existingWorkspace,
        organizationId,
        userId,
      );

      yield* ensureMemberships({
        writer,
        plan,
        organizationMembership,
        workspaceMembership,
        organizationId,
        workspaceId,
        userId,
      });

      return { workspaceId };
    }),
);

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

/**
 * Provision (insert or patch) the caller's `users` row, returning its id.
 * Mirrors the original inline user-provisioning step exactly.
 */
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

    const userId: GenericId<"users"> =
      existingUser === null
        ? yield* writer
            .table("users")
            .insert(requireInsertValue(userPlan, "user"))
            .pipe(Effect.orDie)
        : asGenericId<"users">(existingUser._id);

    if (existingUser !== null && userPlan.action === "patch") {
      yield* writer
        .table("users")
        .patch(asGenericId<"users">(existingUser._id), userPlan.value)
        .pipe(Effect.orDie);
    }

    return userId;
  });

/** Provision (insert, or reuse) the caller's `organizations` row. */
const ensureOrganizationRow = (
  writer: Writer,
  plan: ProvisioningPlan,
  existingOrganization: OrganizationProvisioningRow | null,
  userId: GenericId<"users">,
) =>
  existingOrganization === null
    ? writer
        .table("organizations")
        .insert({
          ...requireInsertValue(plan.organization, "organization"),
          ownerUserId: userId,
        })
        .pipe(Effect.orDie)
    : Effect.succeed(asGenericId<"organizations">(existingOrganization._id));

/** Provision (insert, or reuse) the caller's `workspaces` row. */
const ensureWorkspaceRow = (
  writer: Writer,
  plan: ProvisioningPlan,
  existingWorkspace: WorkspaceProvisioningRow | null,
  organizationId: GenericId<"organizations">,
  userId: GenericId<"users">,
) =>
  existingWorkspace === null
    ? writer
        .table("workspaces")
        .insert({
          ...requireInsertValue(plan.workspace, "workspace"),
          organizationId,
          ownerUserId: userId,
        })
        .pipe(Effect.orDie)
    : Effect.succeed(asGenericId<"workspaces">(existingWorkspace._id));

/** Provision (insert or patch) the organization- and workspace-membership rows. */
const ensureMemberships = ({
  writer,
  plan,
  organizationMembership,
  workspaceMembership,
  organizationId,
  workspaceId,
  userId,
}: {
  readonly writer: Writer;
  readonly plan: ProvisioningPlan;
  readonly organizationMembership: OrganizationMembershipProvisioningRow | null;
  readonly workspaceMembership: WorkspaceMembershipProvisioningRow | null;
  readonly organizationId: GenericId<"organizations">;
  readonly workspaceId: GenericId<"workspaces">;
  readonly userId: GenericId<"users">;
}) =>
  Effect.gen(function* () {
    if (organizationMembership === null) {
      yield* writer
        .table("organizationMembers")
        .insert({
          ...requireInsertValue(
            plan.organizationMembership,
            "organizationMembership",
          ),
          organizationId,
          userId,
        })
        .pipe(Effect.orDie);
    } else if (plan.organizationMembership.action === "patch") {
      yield* writer
        .table("organizationMembers")
        .patch(
          asGenericId<"organizationMembers">(organizationMembership._id),
          plan.organizationMembership.value,
        )
        .pipe(Effect.orDie);
    }

    if (workspaceMembership === null) {
      yield* writer
        .table("workspaceMembers")
        .insert({
          ...requireInsertValue(
            plan.workspaceMembership,
            "workspaceMembership",
          ),
          workspaceId,
          userId,
        })
        .pipe(Effect.orDie);
    } else if (plan.workspaceMembership.action === "patch") {
      yield* writer
        .table("workspaceMembers")
        .patch(
          asGenericId<"workspaceMembers">(workspaceMembership._id),
          plan.workspaceMembership.value,
        )
        .pipe(Effect.orDie);
    }
  });

export default GroupImpl.make(databaseSchema, provisioning).pipe(
  Layer.provide(ensureProvisioned),
  GroupImpl.finalize,
);
