import * as Either from "effect/Either";

import {
  Forbidden,
  InvitationExpired,
  InvitationNotAccessible,
  InvitationNotPending,
  LastOwnerProtected,
  MemberNotInWorkspace,
  ValidationFailed,
} from "../errors";
import { normalizeEmail } from "./email";
import { roleAtLeast, type Role } from "./roles";

export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type MembershipStatus = "pending" | "active" | "revoked";
type InvitationStatus =
  "pending" | "accepted" | "cancelled" | "declined" | "revoked" | "expired";

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

export type InvitationRef = {
  readonly id: string;
  readonly workspaceId: string;
  readonly organizationId: string;
  readonly email: string;
  readonly role: Role;
  readonly status: InvitationStatus;
  readonly tokenHash: string;
  readonly invitedByUserId: string;
  readonly acceptedAt: number | null;
  readonly revokedAt: number | null;
  readonly expiresAt: number;
  readonly createdAt: number;
  readonly updatedAt: number;
};

type AuditMetadata =
  | { readonly previousRole: Role; readonly nextRole: Role }
  | { readonly role: Role }
  | { readonly email: string; readonly role: Role }
  | { readonly acceptedByUserId: string }
  | { readonly reason: "declined" | "cancelled" };

export type AccessLifecycleEvent = {
  readonly action:
    | "member.roleChanged"
    | "member.removed"
    | "member.ownershipTransferred"
    | "invitation.created"
    | "invitation.accepted"
    | "invitation.declined"
    | "invitation.cancelled";
  readonly workspaceId: string;
  readonly actorUserId: string;
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
  | InvitationExpired
  | InvitationNotAccessible
  | InvitationNotPending
  | LastOwnerProtected
  | MemberNotInWorkspace
  | ValidationFailed;

export type PlannerResult<
  A,
  E extends AccessLifecycleError = AccessLifecycleError,
> = Either.Either<A, E>;

const fail = <E extends AccessLifecycleError>(
  error: E,
): PlannerResult<never, E> => Either.left(error);
const succeed = <A>(value: A): PlannerResult<A, never> => Either.right(value);

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
  const canGrant = requireActorCanGrant(input.actorRole, input.newRole);
  if (Either.isLeft(canGrant)) return fail(canGrant.left);
  if (liveTarget.right.role === "owner" && input.newRole !== "owner") {
    const notLastOwner = requireNotLastOwner(
      input.workspaceId,
      input.liveWorkspaceMembers,
    );
    if (Either.isLeft(notLastOwner)) return fail(notLastOwner.left);
  }

  return succeed({
    patch: {
      id: liveTarget.right.id,
      value: { role: input.newRole, updatedAt: input.now },
    },
    events: [
      {
        action: "member.roleChanged",
        workspaceId: input.workspaceId,
        actorUserId: input.actorUserId,
        subjectKind: "workspaceMember",
        subjectId: liveTarget.right.id,
        metadata: {
          previousRole: liveTarget.right.role,
          nextRole: input.newRole,
        },
      },
    ],
  });
};

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

export const buildWorkspaceInvitation = (input: {
  readonly workspaceId: string;
  readonly organizationId: string;
  readonly inviteeEmail: string;
  readonly role: Role;
  readonly invitedByUserId: string;
  readonly tokenHash: string;
  readonly now: number;
}): PlannerResult<
  {
    readonly invitation: Omit<InvitationRef, "id">;
    readonly events: readonly AccessLifecycleEvent[];
  },
  ValidationFailed
> => {
  const email = requireNormalizedEmail(input.inviteeEmail, "email");
  if (Either.isLeft(email)) return fail(email.left);
  const invitation = {
    workspaceId: input.workspaceId,
    organizationId: input.organizationId,
    email: email.right,
    role: input.role,
    status: "pending" as const,
    tokenHash: input.tokenHash,
    invitedByUserId: input.invitedByUserId,
    acceptedAt: null,
    revokedAt: null,
    expiresAt: input.now + INVITATION_TTL_MS,
    createdAt: input.now,
    updatedAt: input.now,
  };

  return succeed({
    invitation,
    events: [
      {
        action: "invitation.created",
        workspaceId: input.workspaceId,
        actorUserId: input.invitedByUserId,
        subjectKind: "invitation",
        subjectId: input.tokenHash,
        metadata: { email: email.right, role: input.role },
      },
    ],
  });
};

export const acceptInvitation = (input: {
  readonly invitation: InvitationRef | null;
  readonly verifiedEmail: string | null | undefined;
  readonly userId: string;
  readonly existingLiveMembership: WorkspaceMemberLifecycleRef | null;
  readonly now: number;
}): PlannerResult<
  {
    readonly invitationPatch: Patch<{
      readonly status: "accepted";
      readonly acceptedAt: number;
      readonly updatedAt: number;
    }>;
    readonly membershipInsert: Omit<WorkspaceMemberLifecycleRef, "id"> | null;
    readonly events: readonly AccessLifecycleEvent[];
  },
  InvitationExpired | InvitationNotAccessible | InvitationNotPending
> => {
  const invitation = requireAccessibleInvitation(
    input.invitation,
    input.verifiedEmail,
  );
  if (Either.isLeft(invitation)) return fail(invitation.left);
  const pending = requireInvitationPending(invitation.right);
  if (Either.isLeft(pending)) return fail(pending.left);
  if (invitation.right.expiresAt <= input.now) {
    return fail(new InvitationExpired({ invitationId: invitation.right.id }));
  }

  return succeed({
    invitationPatch: {
      id: invitation.right.id,
      value: {
        status: "accepted",
        acceptedAt: input.now,
        updatedAt: input.now,
      },
    },
    membershipInsert:
      input.existingLiveMembership === null
        ? {
            workspaceId: invitation.right.workspaceId,
            userId: input.userId,
            role: invitation.right.role,
            status: "active",
            acceptedAt: input.now,
            revokedAt: null,
            deletedAt: null,
          }
        : null,
    events: [
      {
        action: "invitation.accepted",
        workspaceId: invitation.right.workspaceId,
        actorUserId: input.userId,
        subjectKind: "invitation",
        subjectId: invitation.right.id,
        metadata: { acceptedByUserId: input.userId },
      },
    ],
  });
};

export const declineInvitation = (input: {
  readonly invitation: InvitationRef | null;
  readonly verifiedEmail: string | null | undefined;
  readonly now: number;
}): PlannerResult<
  {
    readonly invitationPatch: Patch<{
      readonly status: "declined";
      readonly revokedAt: number;
      readonly updatedAt: number;
    }> | null;
    readonly events: readonly AccessLifecycleEvent[];
  },
  InvitationNotAccessible
> => {
  const invitation = requireAccessibleInvitation(
    input.invitation,
    input.verifiedEmail,
  );
  if (Either.isLeft(invitation)) return fail(invitation.left);
  if (invitation.right.status !== "pending") {
    return succeed({ invitationPatch: null, events: [] });
  }
  return succeed({
    invitationPatch: {
      id: invitation.right.id,
      value: {
        status: "declined",
        revokedAt: input.now,
        updatedAt: input.now,
      },
    },
    events: [
      {
        action: "invitation.declined",
        workspaceId: invitation.right.workspaceId,
        actorUserId: invitation.right.email,
        subjectKind: "invitation",
        subjectId: invitation.right.id,
        metadata: { reason: "declined" },
      },
    ],
  });
};

export const cancelInvitation = (input: {
  readonly invitation: InvitationRef | null;
  readonly workspaceId: string;
  readonly actorUserId: string;
  readonly now: number;
}): PlannerResult<
  {
    readonly invitationPatch: Patch<{
      readonly status: "cancelled";
      readonly revokedAt: number;
      readonly updatedAt: number;
    }> | null;
    readonly events: readonly AccessLifecycleEvent[];
  },
  never
> => {
  if (
    input.invitation === null ||
    input.invitation.workspaceId !== input.workspaceId ||
    input.invitation.status !== "pending"
  ) {
    return succeed({ invitationPatch: null, events: [] });
  }
  return succeed({
    invitationPatch: {
      id: input.invitation.id,
      value: {
        status: "cancelled",
        revokedAt: input.now,
        updatedAt: input.now,
      },
    },
    events: [
      {
        action: "invitation.cancelled",
        workspaceId: input.workspaceId,
        actorUserId: input.actorUserId,
        subjectKind: "invitation",
        subjectId: input.invitation.id,
        metadata: { reason: "cancelled" },
      },
    ],
  });
};

const requireLiveWorkspaceMember = (
  member: WorkspaceMemberLifecycleRef,
  workspaceId: string,
): PlannerResult<WorkspaceMemberLifecycleRef, MemberNotInWorkspace> => {
  if (
    member.workspaceId !== workspaceId ||
    member.status !== "active" ||
    member.acceptedAt === null ||
    member.revokedAt !== null ||
    member.deletedAt !== null
  ) {
    return fail(new MemberNotInWorkspace({ membershipId: member.id }));
  }
  return succeed(member);
};

const requireActorCanManage = (
  actorRole: Role,
  targetRole: Role,
): PlannerResult<void, Forbidden> => {
  if (!roleAtLeast(actorRole, targetRole)) {
    return fail(
      new Forbidden({
        reason: "Cannot manage a member with a higher role.",
      }),
    );
  }
  return succeed(undefined);
};

const requireActorCanGrant = (
  actorRole: Role,
  newRole: Role,
): PlannerResult<void, Forbidden> => {
  if (!roleAtLeast(actorRole, newRole)) {
    return fail(
      new Forbidden({
        reason: "Cannot grant a role higher than your own.",
      }),
    );
  }
  return succeed(undefined);
};

const requireNotLastOwner = (
  workspaceId: string,
  members: readonly WorkspaceMemberLifecycleRef[],
): PlannerResult<void, LastOwnerProtected> => {
  const liveOwners = members.filter(
    (member) =>
      member.workspaceId === workspaceId &&
      member.role === "owner" &&
      member.status === "active" &&
      member.acceptedAt !== null &&
      member.revokedAt === null &&
      member.deletedAt === null,
  );
  if (liveOwners.length <= 1) {
    return fail(new LastOwnerProtected({ workspaceId }));
  }
  return succeed(undefined);
};

const requireNormalizedEmail = (
  value: string,
  field: string,
): PlannerResult<string, ValidationFailed> => {
  const normalized = normalizeEmail(value);
  if (normalized.kind !== "verified") {
    return fail(
      new ValidationFailed({
        field,
        message: "A valid email address is required.",
      }),
    );
  }
  return succeed(normalized.email);
};

const normalizeAccessibleEmail = (
  value: string | null | undefined,
): string | null => {
  const normalized = normalizeEmail(value);
  return normalized.kind === "verified" ? normalized.email : null;
};

const requireAccessibleInvitation = (
  invitation: InvitationRef | null,
  verifiedEmail: string | null | undefined,
): PlannerResult<InvitationRef, InvitationNotAccessible> => {
  const email = normalizeAccessibleEmail(verifiedEmail);
  if (invitation === null || email === null) {
    return fail(new InvitationNotAccessible());
  }
  const invitationEmail = normalizeAccessibleEmail(invitation.email);
  if (invitationEmail === null || invitationEmail !== email) {
    return fail(new InvitationNotAccessible());
  }
  return succeed(invitation);
};

const requireInvitationPending = (
  invitation: InvitationRef,
): PlannerResult<void, InvitationNotPending> => {
  if (invitation.status !== "pending") {
    return fail(new InvitationNotPending({ invitationId: invitation.id }));
  }
  return succeed(undefined);
};
