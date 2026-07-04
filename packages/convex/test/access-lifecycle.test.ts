import * as Either from "effect/Either";
import { describe, expect, it } from "vitest";

import {
  acceptInvitation,
  buildWorkspaceInvitation,
  cancelInvitation,
  changeMemberRole,
  declineInvitation,
  removeMember,
  transferOwnership,
  type InvitationRef,
  type WorkspaceMemberLifecycleRef,
} from "../confect/access/lifecycle";
import {
  Forbidden,
  InvitationExpired,
  InvitationNotAccessible,
  InvitationNotPending,
  LastOwnerProtected,
  MemberNotInWorkspace,
} from "../confect/errors";

const now = 1_782_924_800_000;

const expectRight = <A, E>(result: Either.Either<A, E>): A => {
  expect(Either.isRight(result)).toBe(true);
  return (result as { readonly right: A }).right;
};

const expectLeft = <A, E>(result: Either.Either<A, E>): E => {
  expect(Either.isLeft(result)).toBe(true);
  return (result as { readonly left: E }).left;
};

const member = (
  overrides: Partial<WorkspaceMemberLifecycleRef>,
): WorkspaceMemberLifecycleRef => ({
  id: "workspaceMembers_1",
  workspaceId: "workspaces_1",
  userId: "users_1",
  role: "editor",
  status: "active",
  acceptedAt: now - 100,
  revokedAt: null,
  deletedAt: null,
  ...overrides,
});

const invitation = (overrides: Partial<InvitationRef>): InvitationRef => ({
  id: "invitations_1",
  workspaceId: "workspaces_1",
  organizationId: "organizations_1",
  email: "ada@example.com",
  role: "editor",
  status: "pending",
  tokenHash: "token_hash",
  invitedByUserId: "users_inviter",
  acceptedAt: null,
  revokedAt: null,
  expiresAt: now + 10_000,
  createdAt: now - 100,
  updatedAt: now - 100,
  ...overrides,
});

describe("workspace member lifecycle policy", () => {
  it("changes a member role when the actor can manage the target and grant the new role", () => {
    const result = expectRight(
      changeMemberRole({
        actorUserId: "users_owner",
        actorRole: "owner",
        workspaceId: "workspaces_1",
        target: member({ id: "workspaceMembers_2", role: "editor" }),
        liveWorkspaceMembers: [
          member({
            id: "workspaceMembers_owner",
            userId: "users_owner",
            role: "owner",
          }),
          member({ id: "workspaceMembers_2", role: "editor" }),
        ],
        newRole: "admin",
        now,
      }),
    );

    expect(result.patch).toEqual({
      id: "workspaceMembers_2",
      value: { role: "admin", updatedAt: now },
    });
    expect(result.events).toEqual([
      {
        action: "member.roleChanged",
        workspaceId: "workspaces_1",
        actorUserId: "users_owner",
        subjectKind: "workspaceMember",
        subjectId: "workspaceMembers_2",
        metadata: { previousRole: "editor", nextRole: "admin" },
      },
    ]);
  });

  it("blocks self-escalation and acting on a higher role", () => {
    const escalation = expectLeft(
      changeMemberRole({
        actorUserId: "users_admin",
        actorRole: "admin",
        workspaceId: "workspaces_1",
        target: member({ role: "admin", userId: "users_admin" }),
        liveWorkspaceMembers: [
          member({ role: "admin", userId: "users_admin" }),
        ],
        newRole: "owner",
        now,
      }),
    );
    expect(escalation).toBeInstanceOf(Forbidden);

    const removal = expectLeft(
      removeMember({
        actorUserId: "users_admin",
        actorRole: "admin",
        workspaceId: "workspaces_1",
        target: member({ id: "workspaceMembers_owner", role: "owner" }),
        liveWorkspaceMembers: [
          member({ id: "workspaceMembers_owner", role: "owner" }),
          member({ id: "workspaceMembers_other", role: "owner" }),
        ],
        now,
      }),
    );
    expect(removal).toBeInstanceOf(Forbidden);
  });

  it("protects the last owner from demotion or removal", () => {
    const owner = member({ role: "owner" });

    const demotion = expectLeft(
      changeMemberRole({
        actorUserId: "users_owner",
        actorRole: "owner",
        workspaceId: "workspaces_1",
        target: owner,
        liveWorkspaceMembers: [owner],
        newRole: "admin",
        now,
      }),
    );
    expect(demotion).toBeInstanceOf(LastOwnerProtected);

    const removal = expectLeft(
      removeMember({
        actorUserId: "users_owner",
        actorRole: "owner",
        workspaceId: "workspaces_1",
        target: owner,
        liveWorkspaceMembers: [owner],
        now,
      }),
    );
    expect(removal).toBeInstanceOf(LastOwnerProtected);
  });

  it("refuses removed, pending, revoked, or cross-workspace members", () => {
    const result = expectLeft(
      changeMemberRole({
        actorUserId: "users_owner",
        actorRole: "owner",
        workspaceId: "workspaces_1",
        target: member({ workspaceId: "workspaces_2" }),
        liveWorkspaceMembers: [],
        newRole: "admin",
        now,
      }),
    );
    expect(result).toBeInstanceOf(MemberNotInWorkspace);
  });

  it("transfers ownership by promoting the target and stepping the caller down", () => {
    const result = expectRight(
      transferOwnership({
        actorUserId: "users_owner",
        workspaceId: "workspaces_1",
        target: member({
          id: "workspaceMembers_target",
          userId: "users_target",
          role: "editor",
        }),
        actorMembership: member({
          id: "workspaceMembers_actor",
          userId: "users_owner",
          role: "owner",
        }),
        now,
      }),
    );

    expect(result.patches).toEqual([
      {
        id: "workspaceMembers_target",
        value: { role: "owner", updatedAt: now },
      },
      {
        id: "workspaceMembers_actor",
        value: { role: "admin", updatedAt: now },
      },
    ]);
    expect(result.events.map((event) => event.action)).toEqual([
      "member.ownershipTransferred",
    ]);
  });
});

describe("workspace invitation lifecycle policy", () => {
  it("builds a normalized pending invitation with an audit event", () => {
    const result = expectRight(
      buildWorkspaceInvitation({
        workspaceId: "workspaces_1",
        organizationId: "organizations_1",
        inviteeEmail: " ADA@Example.COM ",
        role: "editor",
        invitedByUserId: "users_owner",
        tokenHash: "token_hash",
        now,
      }),
    );

    expect(result.invitation).toMatchObject({
      workspaceId: "workspaces_1",
      organizationId: "organizations_1",
      email: "ada@example.com",
      role: "editor",
      status: "pending",
      expiresAt: now + 7 * 24 * 60 * 60 * 1000,
    });
    expect(result.events).toEqual([
      {
        action: "invitation.created",
        workspaceId: "workspaces_1",
        actorUserId: "users_owner",
        subjectKind: "invitation",
        subjectId: "token_hash",
        metadata: { email: "ada@example.com", role: "editor" },
      },
    ]);
  });

  it("opaque-denies missing, wrong-email, and blank-email invite access", () => {
    const missing = expectLeft(
      acceptInvitation({
        invitation: null,
        verifiedEmail: "ada@example.com",
        userId: "users_ada",
        existingLiveMembership: null,
        now,
      }),
    );
    expect(missing).toBeInstanceOf(InvitationNotAccessible);

    const wrongEmail = expectLeft(
      acceptInvitation({
        invitation: invitation({ email: "ada@example.com" }),
        verifiedEmail: "grace@example.com",
        userId: "users_grace",
        existingLiveMembership: null,
        now,
      }),
    );
    expect(wrongEmail).toBeInstanceOf(InvitationNotAccessible);

    const blankEmail = expectLeft(
      declineInvitation({
        invitation: invitation({ email: "" }),
        verifiedEmail: " ",
        now,
      }),
    );
    expect(blankEmail).toBeInstanceOf(InvitationNotAccessible);
  });

  it("rejects non-pending and expired invitations after verifying the invitee", () => {
    const nonPending = expectLeft(
      acceptInvitation({
        invitation: invitation({ status: "accepted" }),
        verifiedEmail: "ada@example.com",
        userId: "users_ada",
        existingLiveMembership: null,
        now,
      }),
    );
    expect(nonPending).toBeInstanceOf(InvitationNotPending);

    const expired = expectLeft(
      acceptInvitation({
        invitation: invitation({ expiresAt: now }),
        verifiedEmail: "ada@example.com",
        userId: "users_ada",
        existingLiveMembership: null,
        now,
      }),
    );
    expect(expired).toBeInstanceOf(InvitationExpired);
  });

  it("accepts by creating one membership unless the invitee is already a live member", () => {
    const accepted = expectRight(
      acceptInvitation({
        invitation: invitation({}),
        verifiedEmail: "ADA@example.com",
        userId: "users_ada",
        existingLiveMembership: null,
        now,
      }),
    );

    expect(accepted.membershipInsert).toMatchObject({
      workspaceId: "workspaces_1",
      userId: "users_ada",
      role: "editor",
      status: "active",
      acceptedAt: now,
      revokedAt: null,
      deletedAt: null,
    });
    expect(accepted.invitationPatch).toEqual({
      id: "invitations_1",
      value: { status: "accepted", acceptedAt: now, updatedAt: now },
    });

    const alreadyMember = expectRight(
      acceptInvitation({
        invitation: invitation({}),
        verifiedEmail: "ada@example.com",
        userId: "users_ada",
        existingLiveMembership: member({ userId: "users_ada" }),
        now,
      }),
    );

    expect(alreadyMember.membershipInsert).toBeNull();
  });

  it("declines and cancels only pending invitations", () => {
    const declined = expectRight(
      declineInvitation({
        invitation: invitation({}),
        verifiedEmail: "ada@example.com",
        now,
      }),
    );

    expect(declined.invitationPatch).toEqual({
      id: "invitations_1",
      value: { status: "declined", revokedAt: now, updatedAt: now },
    });
    expect(declined.events).toEqual([
      {
        action: "invitation.declined",
        workspaceId: "workspaces_1",
        actorEmail: "ada@example.com",
        subjectKind: "invitation",
        subjectId: "invitations_1",
        metadata: { reason: "declined" },
      },
    ]);

    expect(
      expectRight(
        cancelInvitation({
          invitation: invitation({ workspaceId: "workspaces_1" }),
          workspaceId: "workspaces_1",
          actorUserId: "users_owner",
          now,
        }),
      ).invitationPatch,
    ).toEqual({
      id: "invitations_1",
      value: { status: "cancelled", revokedAt: now, updatedAt: now },
    });

    expect(
      expectRight(
        cancelInvitation({
          invitation: invitation({ status: "accepted" }),
          workspaceId: "workspaces_1",
          actorUserId: "users_owner",
          now,
        }),
      ).invitationPatch,
    ).toBeNull();

    expect(
      expectRight(
        cancelInvitation({
          invitation: invitation({ workspaceId: "workspaces_other" }),
          workspaceId: "workspaces_1",
          actorUserId: "users_owner",
          now,
        }),
      ).invitationPatch,
    ).toBeNull();
  });
});
