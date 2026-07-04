import { FunctionImpl, GroupImpl } from "@confect/server";
import type { GenericId } from "convex/values";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import databaseSchema from "../_generated/schema";
import { Auth, DatabaseReader, DatabaseWriter } from "../_generated/services";
import { ProvisioningConflict, Unauthorized } from "../errors";
import provisioning from "./provisioning.spec";
import {
  buildProvisioningPlan,
  extractIdentityProfile,
  type IdentityProfile,
  type OrganizationMembershipProvisioningRow,
  selectLiveOwnedOrganization,
  selectLiveOwnedWorkspace,
  type OrganizationProvisioningRow,
  type ProvisioningPlan,
  type RowPlan,
  type UserProvisioningRow,
  type WorkspaceMembershipProvisioningRow,
  type WorkspaceProvisioningRow,
} from "./provisioning";

const ensureProvisioned = FunctionImpl.make(
  databaseSchema,
  provisioning,
  "ensureProvisioned",
  () =>
    Effect.gen(function* () {
      const identity = yield* readIdentityProfile();
      const now = yield* Clock.currentTimeMillis;

      const existingUser = yield* readProvisioningUser(identity.subject);
      const userId = yield* provisionUser({ identity, existingUser, now });
      const { existingOrganization, existingWorkspace } =
        yield* readOwnedWorkspaceState(userId);
      const { organizationMembership, workspaceMembership } =
        yield* readMembershipState({
          userId,
          existingOrganization,
          existingWorkspace,
        });

      const plan = buildProvisioningPlan({
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

      const organizationId = yield* provisionOrganization({
        plan,
        existingOrganization,
        userId,
      });
      const workspaceId = yield* provisionWorkspace({
        plan,
        existingWorkspace,
        organizationId,
        userId,
      });
      yield* provisionMemberships({
        plan,
        organizationMembership,
        organizationId,
        workspaceMembership,
        workspaceId,
        userId,
      });

      return { workspaceId };
    }),
);

const readIdentityProfile = () =>
  Effect.gen(function* () {
    const auth = yield* Auth;
    return yield* extractIdentityProfile(
      yield* auth.getUserIdentity.pipe(
        Effect.mapError(() => new Unauthorized()),
      ),
    );
  });

const readProvisioningUser = (subject: string) =>
  Effect.gen(function* () {
    const reader = yield* DatabaseReader;
    return yield* reader
      .table("users")
      .index("by_subject", (q) => q.eq("subject", subject))
      .first()
      .pipe(
        Effect.map(Option.getOrNull),
        Effect.map((user) => (user === null ? null : toProvisioningUser(user))),
        Effect.orDie,
      );
  });

const provisionUser = (input: {
  readonly identity: IdentityProfile;
  readonly existingUser: UserProvisioningRow | null;
  readonly now: number;
}) =>
  Effect.gen(function* () {
    const writer = yield* DatabaseWriter;
    const userPlan = buildProvisioningPlan({
      identity: input.identity,
      state: {
        user: input.existingUser,
        liveOrganization: null,
        liveWorkspace: null,
        organizationMembership: null,
        workspaceMembership: null,
      },
      now: input.now,
    }).user;

    if (input.existingUser === null) {
      return yield* writer
        .table("users")
        .insert(requireInsertValue(userPlan, "user"))
        .pipe(Effect.orDie);
    }

    const userId = toId<"users">(input.existingUser._id);
    if (userPlan.action === "patch") {
      yield* writer
        .table("users")
        .patch(userId, userPlan.value)
        .pipe(Effect.orDie);
    }
    return userId;
  });

const readOwnedWorkspaceState = (userId: GenericId<"users">) =>
  Effect.gen(function* () {
    const reader = yield* DatabaseReader;
    const organizations = yield* reader
      .table("organizations")
      .index("by_owner", (q) => q.eq("ownerUserId", userId))
      .take(100)
      .pipe(Effect.orDie);
    const existingOrganization = yield* selectProvisioningRow(() =>
      selectLiveOwnedOrganization(organizations, userId),
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
    const existingWorkspace = yield* selectProvisioningRow(() =>
      selectLiveOwnedWorkspace(workspaces, userId),
    );

    return { existingOrganization, existingWorkspace };
  });

const readMembershipState = (input: {
  readonly userId: GenericId<"users">;
  readonly existingOrganization: OrganizationProvisioningRow | null;
  readonly existingWorkspace: WorkspaceProvisioningRow | null;
}) =>
  Effect.gen(function* () {
    const reader = yield* DatabaseReader;
    const existingOrganization = input.existingOrganization;
    const existingWorkspace = input.existingWorkspace;
    const organizationMembership =
      existingOrganization === null
        ? null
        : yield* reader
            .table("organizationMembers")
            .index("by_organization_user", (q) =>
              q
                .eq("organizationId", existingOrganization._id)
                .eq("userId", input.userId),
            )
            .first()
            .pipe(Effect.map(Option.getOrNull), Effect.orDie);

    const workspaceMembership =
      existingWorkspace === null
        ? null
        : yield* reader
            .table("workspaceMembers")
            .index("by_workspace_user", (q) => {
              const scoped = q.eq("workspaceId", existingWorkspace._id);
              return scoped.eq("userId", input.userId);
            })
            .first()
            .pipe(Effect.map(Option.getOrNull), Effect.orDie);

    return { organizationMembership, workspaceMembership };
  });

const provisionOrganization = (input: {
  readonly plan: ProvisioningPlan;
  readonly existingOrganization: OrganizationProvisioningRow | null;
  readonly userId: GenericId<"users">;
}) =>
  Effect.gen(function* () {
    if (input.existingOrganization !== null) {
      return toId<"organizations">(input.existingOrganization._id);
    }

    const writer = yield* DatabaseWriter;
    return yield* writer
      .table("organizations")
      .insert({
        ...requireInsertValue(input.plan.organization, "organization"),
        ownerUserId: input.userId,
      })
      .pipe(Effect.orDie);
  });

const provisionWorkspace = (input: {
  readonly plan: ProvisioningPlan;
  readonly existingWorkspace: WorkspaceProvisioningRow | null;
  readonly organizationId: GenericId<"organizations">;
  readonly userId: GenericId<"users">;
}) =>
  Effect.gen(function* () {
    if (input.existingWorkspace !== null) {
      return toId<"workspaces">(input.existingWorkspace._id);
    }

    const writer = yield* DatabaseWriter;
    return yield* writer
      .table("workspaces")
      .insert({
        ...requireInsertValue(input.plan.workspace, "workspace"),
        organizationId: input.organizationId,
        ownerUserId: input.userId,
      })
      .pipe(Effect.orDie);
  });

const provisionMemberships = (input: {
  readonly plan: ProvisioningPlan;
  readonly organizationMembership: OrganizationMembershipProvisioningRow | null;
  readonly organizationId: GenericId<"organizations">;
  readonly workspaceMembership: WorkspaceMembershipProvisioningRow | null;
  readonly workspaceId: GenericId<"workspaces">;
  readonly userId: GenericId<"users">;
}) =>
  Effect.gen(function* () {
    const writer = yield* DatabaseWriter;
    yield* applyMembershipPlan({
      existing: input.organizationMembership,
      plan: input.plan.organizationMembership,
      label: "organizationMembership",
      insert: (value) =>
        insertMembership(
          value,
          { organizationId: input.organizationId, userId: input.userId },
          (row) =>
            writer.table("organizationMembers").insert(row).pipe(Effect.orDie),
        ),
      patch: (id, value) => patchOrganizationMembership(writer, id, value),
    });

    yield* applyMembershipPlan({
      existing: input.workspaceMembership,
      plan: input.plan.workspaceMembership,
      label: "workspaceMembership",
      insert: (value) =>
        insertMembership(
          value,
          { workspaceId: input.workspaceId, userId: input.userId },
          (row) =>
            writer.table("workspaceMembers").insert(row).pipe(Effect.orDie),
        ),
      patch: (id, value) => patchWorkspaceMembership(writer, id, value),
    });
  });

type Writer = typeof DatabaseWriter.Service;

const patchOrganizationMembership = (
  writer: Writer,
  id: string,
  value: Partial<Omit<OrganizationMembershipProvisioningRow, "_id">>,
) =>
  writer
    .table("organizationMembers")
    .patch(toId<"organizationMembers">(id), value)
    .pipe(Effect.orDie);

const patchWorkspaceMembership = (
  writer: Writer,
  id: string,
  value: Partial<Omit<WorkspaceMembershipProvisioningRow, "_id">>,
) =>
  writer
    .table("workspaceMembers")
    .patch(toId<"workspaceMembers">(id), value)
    .pipe(Effect.orDie);

const insertMembership = <Value extends object, Scope extends object>(
  value: Value,
  scope: Scope,
  write: (row: Value & Scope) => Effect.Effect<unknown>,
) => write(scopedMembershipValue(value, scope));

const scopedMembershipValue = <Value extends object, Scope extends object>(
  value: Value,
  scope: Scope,
): Value & Scope => ({ ...value, ...scope });

const applyMembershipPlan = <
  Row extends { readonly _id: string },
  Value,
>(input: {
  readonly existing: Row | null;
  readonly plan: RowPlan<Value>;
  readonly label: string;
  readonly insert: (value: Value) => Effect.Effect<unknown>;
  readonly patch: (id: string, value: Partial<Value>) => Effect.Effect<unknown>;
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (input.existing === null) {
      yield* input.insert(requireInsertValue(input.plan, input.label));
      return;
    }

    if (input.plan.action === "patch") {
      yield* input.patch(input.existing._id, input.plan.value);
    }
  });

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

const requireInsertValue = <Value>(
  plan:
    | { readonly action: "insert"; readonly value: Value }
    | { readonly action: "patch" }
    | { readonly action: "none" },
  label: string,
): Value => {
  if (plan.action !== "insert") {
    throw new Error(`Expected ${label} provisioning insert plan.`);
  }
  return plan.value;
};

const toId = <TableName extends string>(id: string): GenericId<TableName> =>
  id as GenericId<TableName>;

const selectProvisioningRow = <
  Row extends OrganizationProvisioningRow | WorkspaceProvisioningRow,
>(
  select: () => Row | null,
): Effect.Effect<Row | null, ProvisioningConflict> =>
  Effect.try({
    try: select,
    catch: (error) =>
      error instanceof ProvisioningConflict
        ? error
        : new ProvisioningConflict({
            resource: "provisioning",
            message: "Unexpected provisioning selection failure.",
          }),
  });

export default GroupImpl.make(databaseSchema, provisioning).pipe(
  Layer.provide(ensureProvisioned),
  GroupImpl.finalize,
);
