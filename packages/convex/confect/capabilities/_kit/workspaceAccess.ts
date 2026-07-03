import type { GenericId } from "convex/values";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { resolveEffectiveWorkspaceRole } from "../../access/auth";
import { roleAtLeast, type Role } from "../../access/roles";
import { Auth, DatabaseReader } from "../../_generated/services";
import {
  MemberNotInWorkspace,
  Unauthorized,
  WorkspaceNotFound,
} from "../../errors";

export type WorkspaceAccess = {
  readonly userId: GenericId<"users">;
  readonly workspaceId: GenericId<"workspaces">;
  readonly role: Role;
  readonly reason: string;
};

export const requireWorkspaceAccess = (
  workspaceId: GenericId<"workspaces">,
  minimumRole: Role,
): Effect.Effect<
  WorkspaceAccess,
  Unauthorized | WorkspaceNotFound | MemberNotInWorkspace,
  Auth | DatabaseReader | Clock.Clock
> =>
  Effect.gen(function* () {
    const auth = yield* Auth;
    const reader = yield* DatabaseReader;
    const identity = yield* auth.getUserIdentity.pipe(
      Effect.mapError(() => new Unauthorized()),
    );

    const user = yield* reader
      .table("users")
      .index("by_subject", (q) => q.eq("subject", identity.subject))
      .first()
      .pipe(Effect.map(Option.getOrNull), Effect.orDie);
    if (user === null || user.status !== "active") {
      return yield* Effect.fail(new Unauthorized());
    }

    const workspace = yield* reader
      .table("workspaces")
      .get(workspaceId)
      .pipe(Effect.orDie);
    if (workspace === null) {
      return yield* Effect.fail(new WorkspaceNotFound({ workspaceId }));
    }

    const organizationId = toId<"organizations">(workspace.organizationId);
    const organization = yield* reader
      .table("organizations")
      .get(organizationId)
      .pipe(Effect.orDie);
    const nowMs = yield* Clock.currentTimeMillis;
    const workspaceMembers = yield* reader
      .table("workspaceMembers")
      .index("by_workspace_user", (q) =>
        q.eq("workspaceId", workspaceId).eq("userId", user._id),
      )
      .take(2)
      .pipe(Effect.orDie);
    const organizationMembers = yield* reader
      .table("organizationMembers")
      .index("by_organization_user", (q) =>
        q.eq("organizationId", workspace.organizationId).eq("userId", user._id),
      )
      .take(2)
      .pipe(Effect.orDie);
    const resolution = resolveEffectiveWorkspaceRole({
      nowMs,
      userId: user._id,
      workspace: {
        id: workspace._id,
        organizationId: workspace.organizationId,
        status: workspace.status,
      },
      ...(organization === null
        ? {}
        : {
            organization: {
              id: organization._id,
              status: organization.status,
            },
          }),
      workspaceMembers: workspaceMembers.map((member) => ({
        workspaceId: member.workspaceId,
        userId: member.userId,
        role: member.role,
        status: member.status,
        acceptedAt: member.acceptedAt,
        revokedAt: member.revokedAt,
        deletedAt: member.deletedAt,
      })),
      organizationMembers: organizationMembers.map((member) => ({
        organizationId: member.organizationId,
        userId: member.userId,
        role: member.role,
        status: member.status,
        acceptedAt: member.acceptedAt,
        revokedAt: member.revokedAt,
      })),
      guestGrants: [],
    });

    if (!resolution.ok || !roleAtLeast(resolution.role, minimumRole)) {
      return yield* Effect.fail(
        new MemberNotInWorkspace({
          membershipId: `${workspaceId}:${user._id}`,
        }),
      );
    }

    return {
      userId: user._id,
      workspaceId,
      role: resolution.role,
      reason: resolution.reason,
    };
  });

const toId = <TableName extends string>(id: string): GenericId<TableName> =>
  id as GenericId<TableName>;
