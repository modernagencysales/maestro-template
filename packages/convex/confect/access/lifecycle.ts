import * as Either from "effect/Either";

import { Forbidden, LastOwnerProtected, MemberNotInWorkspace } from "../errors";
import type {
  InvitationExpired,
  InvitationNotAccessible,
  InvitationNotPending,
  ValidationFailed,
} from "../errors";
import {
  requireActorCanGrant,
  requireActorCanManage,
  requireLiveWorkspaceMember,
  requireNotLastOwner,
  requireOwnerRoleChangeAllowed,
} from "./lifecycleMemberGuards";
import type { Role } from "./roles";

export {
  acceptInvitation,
  buildWorkspaceInvitation,
  cancelInvitation,
  declineInvitation,
  INVITATION_TTL_MS,
} from "./lifecycleInvitations";
export type { InvitationRef } from "./lifecycleInvitations";

type MembershipStatus = "pending" | "active" | "revoked";

export type WorkspaceMemberLifecycleRef = {
  readonly id: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly role: Role;
  readonly status: MembershipStatus;
  readonly acceptedAt: number | null;
  readonly revokedAt: number | null;
  readonly deletedAt: number | null;
};

type AuditMetadata =
  | { readonly previousRole: Role; readonly nextRole: Role }
  | { readonly role: Role }
  | { readonly email: string; readonly role: Role }
  | { readonly acceptedByUserId: string }
  | { readonly reason: "declined" | "cancelled" };

type AccessLifecycleActor =
  | { readonly actorUserId: string; readonly actorEmail?: never }
  | { readonly actorUserId?: never; readonly actorEmail: string };

export type AccessLifecycleEvent = AccessLifecycleActor & {
  readonly action:
    | "member.roleChanged"
    | "member.removed"
    | "member.ownershipTransferred"
    | "invitation.created"
    | "invitation.accepted"
    | "invitation.declined"
    | "invitation.cancelled";
  readonly workspaceId: string;
  readonly subjectKind: "workspaceMember" | "invitation";
  readonly subjectId: string;
  readonly metadata: AuditMetadata;
};

type Patch<Value> = {
  readonly id: string;
  readonly value: Value;
};

export type AccessLifecycleError =
  | Forbidden
  | LastOwnerProtected
  | MemberNotInWorkspace
  | InvitationExpired
  | InvitationNotAccessible
  | InvitationNotPending
  | ValidationFailed;

export type PlannerResult<
  A,
  E extends AccessLifecycleError = AccessLifecycleError,
> = Either.Either<A, E>;

const fail = <E extends AccessLifecycleError>(
  error: E,
): PlannerResult<never, E> => Either.left(error);
const succeed = <A>(value: A): PlannerResult<A, never> => Either.right(value);
const flatMapPlannerResult = <
  A,
  E1 extends AccessLifecycleError,
  B,
  E2 extends AccessLifecycleError,
>(
  result: PlannerResult<A, E1>,
  f: (value: A) => PlannerResult<B, E2>,
): PlannerResult<B, E1 | E2> =>
  Either.isLeft(result) ? fail(result.left) : f(result.right);
const mapPlannerResult = <A, E extends AccessLifecycleError, B>(
  result: PlannerResult<A, E>,
  f: (value: A) => B,
): PlannerResult<B, E> =>
  Either.isLeft(result) ? fail(result.left) : succeed(f(result.right));

export const changeMemberRole = (input: {
  readonly actorUserId: string;
  readonly actorRole: Role;
  readonly workspaceId: string;
  readonly target: WorkspaceMemberLifecycleRef;
  readonly liveWorkspaceMembers: readonly WorkspaceMemberLifecycleRef[];
  readonly newRole: Role;
  readonly now: number;
}): PlannerResult<
  {
    readonly patch: Patch<{ readonly role: Role; readonly updatedAt: number }>;
    readonly events: readonly AccessLifecycleEvent[];
  },
  Forbidden | LastOwnerProtected | MemberNotInWorkspace
> => {
  return mapPlannerResult(requireRoleChangeTarget(input), (liveTarget) => ({
    patch: {
      id: liveTarget.id,
      value: { role: input.newRole, updatedAt: input.now },
    },
    events: [
      {
        action: "member.roleChanged",
        workspaceId: input.workspaceId,
        actorUserId: input.actorUserId,
        subjectKind: "workspaceMember",
        subjectId: liveTarget.id,
        metadata: {
          previousRole: liveTarget.role,
          nextRole: input.newRole,
        },
      },
    ],
  }));
};

const requireRoleChangeTarget = (input: {
  readonly actorRole: Role;
  readonly workspaceId: string;
  readonly target: WorkspaceMemberLifecycleRef;
  readonly liveWorkspaceMembers: readonly WorkspaceMemberLifecycleRef[];
  readonly newRole: Role;
}): PlannerResult<
  WorkspaceMemberLifecycleRef,
  Forbidden | LastOwnerProtected | MemberNotInWorkspace
> =>
  flatMapPlannerResult(
    requireLiveWorkspaceMember(input.target, input.workspaceId),
    (liveTarget) =>
      flatMapPlannerResult(
        requireActorCanManage(input.actorRole, liveTarget.role),
        () =>
          flatMapPlannerResult(
            requireActorCanGrant(input.actorRole, input.newRole),
            () =>
              mapPlannerResult(
                requireOwnerRoleChangeAllowed(
                  liveTarget,
                  input.newRole,
                  input.workspaceId,
                  input.liveWorkspaceMembers,
                ),
                () => liveTarget,
              ),
          ),
      ),
  );

export const removeMember = (input: {
  readonly actorUserId: string;
  readonly actorRole: Role;
  readonly workspaceId: string;
  readonly target: WorkspaceMemberLifecycleRef;
  readonly liveWorkspaceMembers: readonly WorkspaceMemberLifecycleRef[];
  readonly now: number;
}): PlannerResult<
  {
    readonly patch: Patch<{
      readonly status: "revoked";
      readonly revokedAt: number;
      readonly deletedAt: number;
      readonly updatedAt: number;
    }>;
    readonly events: readonly AccessLifecycleEvent[];
  },
  Forbidden | LastOwnerProtected | MemberNotInWorkspace
> => {
  const liveTarget = requireLiveWorkspaceMember(
    input.target,
    input.workspaceId,
  );
  if (Either.isLeft(liveTarget)) return fail(liveTarget.left);
  const canManage = requireActorCanManage(
    input.actorRole,
    liveTarget.right.role,
  );
  if (Either.isLeft(canManage)) return fail(canManage.left);
  if (liveTarget.right.role === "owner") {
    const notLastOwner = requireNotLastOwner(
      input.workspaceId,
      input.liveWorkspaceMembers,
    );
    if (Either.isLeft(notLastOwner)) return fail(notLastOwner.left);
  }

  return succeed({
    patch: {
      id: liveTarget.right.id,
      value: {
        status: "revoked",
        revokedAt: input.now,
        deletedAt: input.now,
        updatedAt: input.now,
      },
    },
    events: [
      {
        action: "member.removed",
        workspaceId: input.workspaceId,
        actorUserId: input.actorUserId,
        subjectKind: "workspaceMember",
        subjectId: liveTarget.right.id,
        metadata: { role: liveTarget.right.role },
      },
    ],
  });
};

export const transferOwnership = (input: {
  readonly actorUserId: string;
  readonly workspaceId: string;
  readonly target: WorkspaceMemberLifecycleRef;
  readonly actorMembership: WorkspaceMemberLifecycleRef;
  readonly now: number;
}): PlannerResult<
  {
    readonly patches: readonly Patch<{
      readonly role: Role;
      readonly updatedAt: number;
    }>[];
    readonly events: readonly AccessLifecycleEvent[];
  },
  Forbidden | MemberNotInWorkspace
> => {
  const liveTarget = requireLiveWorkspaceMember(
    input.target,
    input.workspaceId,
  );
  if (Either.isLeft(liveTarget)) return fail(liveTarget.left);
  const liveActor = requireLiveWorkspaceMember(
    input.actorMembership,
    input.workspaceId,
  );
  if (Either.isLeft(liveActor)) return fail(liveActor.left);
  if (
    liveTarget.right.userId === input.actorUserId ||
    liveActor.right.userId !== input.actorUserId ||
    liveActor.right.role !== "owner"
  ) {
    return fail(
      new Forbidden({ reason: "Cannot transfer workspace ownership." }),
    );
  }

  return succeed({
    patches: [
      {
        id: liveTarget.right.id,
        value: { role: "owner", updatedAt: input.now },
      },
      {
        id: liveActor.right.id,
        value: { role: "admin", updatedAt: input.now },
      },
    ],
    events: [
      {
        action: "member.ownershipTransferred",
        workspaceId: input.workspaceId,
        actorUserId: input.actorUserId,
        subjectKind: "workspaceMember",
        subjectId: liveTarget.right.id,
        metadata: { previousRole: liveTarget.right.role, nextRole: "owner" },
      },
    ],
  });
};
