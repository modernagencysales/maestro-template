import type { GenericMutationCtx, GenericQueryCtx } from "convex/server";
import {
  resolveEffectiveWorkspaceRole,
  type OrganizationMemberRef,
  type OrganizationRef,
  type WorkspaceMemberRef,
  type WorkspaceRef,
} from "../access/auth";
import { roleAtLeast } from "../access/roles";
import type { DataModel } from "../../convex/_generated/dataModel";
import { parseEditorTarget } from "./documentTargets";

export type EditorRole = "viewer" | "editor";

type EditorAuthCtx = GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>;

export const resolveEditorWorkspaceId = async (
  ctx: EditorAuthCtx,
  documentId: string,
): Promise<string | null> => {
  const target = parseEditorTarget(documentId);
  if (target.kind !== "brainPage") return null;
  const pageId = ctx.db.normalizeId("brainPages", target.id);
  if (pageId === null) return null;
  const page = await ctx.db.get(pageId);
  return page?.workspaceId ?? null;
};

export const requireEditorDocumentAccess = async (
  ctx: EditorAuthCtx,
  documentId: string,
  role: EditorRole,
): Promise<void> => {
  const workspaceId = await resolveEditorWorkspaceId(ctx, documentId);
  if (workspaceId === null) {
    throw new Error("Editor document target is not readable.");
  }

  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) {
    throw new Error("Editor sync requires authentication.");
  }

  const user = await ctx.db
    .query("users")
    .withIndex("by_subject", (q) => q.eq("subject", identity.subject))
    .unique();

  if (user === null) {
    throw new Error("Editor sync requires a provisioned user.");
  }
  if (user.status !== "active") {
    throw new Error("Editor sync requires an active user.");
  }

  const workspace = await ctx.db.normalizeId("workspaces", workspaceId);
  if (workspace === null) {
    throw new Error("Editor sync requires an active workspace.");
  }
  const workspaceRow = await ctx.db.get(workspace);
  if (workspaceRow === null) {
    throw new Error("Editor sync requires an active workspace.");
  }

  const organizationId = ctx.db.normalizeId(
    "organizations",
    workspaceRow.organizationId,
  );
  if (organizationId === null) {
    throw new Error("Editor sync requires an active organization.");
  }
  const organization = await ctx.db.get(organizationId);
  if (organization === null) {
    throw new Error("Editor sync requires an active organization.");
  }

  const workspaceMembers = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_workspace_user", (q) =>
      q.eq("workspaceId", workspaceId).eq("userId", user._id),
    )
    .collect();
  const organizationMembers = await ctx.db
    .query("organizationMembers")
    .withIndex("by_organization_user", (q) =>
      q
        .eq("organizationId", workspaceRow.organizationId)
        .eq("userId", user._id),
    )
    .collect();

  const resolution = resolveEffectiveWorkspaceRole({
    nowMs: Date.now(),
    userId: user._id,
    workspace: {
      id: workspaceRow._id,
      organizationId: workspaceRow.organizationId,
      status: workspaceRow.status,
    } satisfies WorkspaceRef,
    organization: {
      id: organization._id,
      status: organization.status,
    } satisfies OrganizationRef,
    workspaceMembers: workspaceMembers as WorkspaceMemberRef[],
    organizationMembers: organizationMembers as OrganizationMemberRef[],
    guestGrants: [],
  });

  if (!resolution.ok) {
    throw new Error("Editor sync requires workspace membership.");
  }

  if (!roleAtLeast(resolution.role, role)) {
    throw new Error(
      role === "editor"
        ? "Editor sync requires editor access."
        : "Editor sync requires workspace membership.",
    );
  }
};
