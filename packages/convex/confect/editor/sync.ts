import type { GenericMutationCtx, GenericQueryCtx } from "convex/server";
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

  const member = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_workspace_user", (q) =>
      q.eq("workspaceId", workspaceId).eq("userId", user._id),
    )
    .unique();

  if (member === null || member.status !== "active") {
    throw new Error("Editor sync requires workspace membership.");
  }

  if (
    role === "editor" &&
    member.role !== "owner" &&
    member.role !== "admin" &&
    member.role !== "editor"
  ) {
    throw new Error("Editor sync requires editor access.");
  }
};
