import type { GenericMutationCtx, GenericQueryCtx } from "convex/server";
import { describe, expect, it, vi } from "vitest";
import type { DataModel } from "../convex/_generated/dataModel";
import { parseEditorTarget } from "../confect/editor/documentTargets";
import { recordEditorSnapshot } from "../confect/editor/syncApi";
import { requireEditorDocumentAccess } from "../confect/editor/sync";
import {
  getSnapshot,
  getSteps,
  latestVersion,
  submitSnapshot,
  submitSteps,
} from "../convex/editorSync";

type TestCtx = GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>;

type IndexCall = {
  readonly table: string;
  readonly index: string;
  readonly eqs: ReadonlyArray<readonly [string, unknown]>;
};

const makeIndexQuery = (table: string, doc: unknown, calls: IndexCall[]) => ({
  withIndex: vi.fn((index: string, build: (q: QueryEq) => QueryEq) => {
    const eqs: Array<readonly [string, unknown]> = [];
    const q: QueryEq = {
      eq: vi.fn((field: string, value: unknown) => {
        eqs.push([field, value]);
        return q;
      }),
    };
    build(q);
    calls.push({ table, index, eqs });
    return {
      unique: vi.fn(async () => doc),
    };
  }),
});

type QueryEq = {
  readonly eq: (field: string, value: unknown) => QueryEq;
};

const makeAuthCtx = ({
  identity = { subject: "subject_1" },
  user = { _id: "user_1" },
  member = { status: "active", role: "editor" },
}: {
  readonly identity?: { readonly subject: string } | null;
  readonly user?: unknown;
  readonly member?: unknown;
} = {}) => {
  const indexCalls: IndexCall[] = [];
  const ctx = {
    auth: {
      getUserIdentity: vi.fn(async () => identity),
    },
    db: {
      normalizeId: vi.fn(() => "page_1"),
      get: vi.fn(async () => ({ _id: "page_1", workspaceId: "workspace_1" })),
      query: vi.fn((table: string) => {
        if (table === "users") return makeIndexQuery(table, user, indexCalls);
        if (table === "workspaceMembers") {
          return makeIndexQuery(table, member, indexCalls);
        }
        throw new Error(`Unexpected table ${table}`);
      }),
    },
  } satisfies Record<string, unknown>;
  return { ctx: ctx as unknown as TestCtx, indexCalls };
};

describe("editor sync registration", () => {
  it("parses only supported editor document targets", () => {
    expect(parseEditorTarget("brainPage:page_1")).toEqual({
      kind: "brainPage",
      id: "page_1",
    });
    expect(() => parseEditorTarget("document_1")).toThrow(
      "Unsupported editor document target",
    );
    expect(() => parseEditorTarget("document:document_1")).toThrow(
      "Unsupported editor document target",
    );
  });

  it("exports the five sync API functions", () => {
    expect(typeof getSnapshot).toBe("function");
    expect(typeof submitSnapshot).toBe("function");
    expect(typeof latestVersion).toBe("function");
    expect(typeof getSteps).toBe("function");
    expect(typeof submitSteps).toBe("function");
  });

  it("rejects unauthenticated access", async () => {
    const { ctx } = makeAuthCtx({ identity: null });

    await expect(
      requireEditorDocumentAccess(ctx, "brainPage:page_1", "viewer"),
    ).rejects.toThrow("Editor sync requires authentication.");
  });

  it("resolves user and workspace membership before allowing editor writes", async () => {
    const { ctx, indexCalls } = makeAuthCtx();

    await expect(
      requireEditorDocumentAccess(ctx, "brainPage:page_1", "editor"),
    ).resolves.toBeUndefined();

    expect(indexCalls).toEqual([
      {
        table: "users",
        index: "by_subject",
        eqs: [["subject", "subject_1"]],
      },
      {
        table: "workspaceMembers",
        index: "by_workspace_user",
        eqs: [
          ["workspaceId", "workspace_1"],
          ["userId", "user_1"],
        ],
      },
    ]);
  });

  it("records Brain page snapshots through the internal mirror mutation", async () => {
    const runMutation = vi.fn(async (_ref: unknown, _args: unknown) => null);
    const ctx = {
      db: {
        normalizeId: vi.fn(() => "page_1"),
        get: vi.fn(async () => ({
          _id: "page_1",
          workspaceId: "workspace_1",
        })),
      },
      runMutation,
    } as unknown as GenericMutationCtx<DataModel>;

    await recordEditorSnapshot(ctx, "brainPage:page_1", '{"type":"doc"}', 42);

    expect(runMutation).toHaveBeenCalledTimes(1);
    const firstCall = runMutation.mock.calls[0];
    expect(firstCall).toBeDefined();
    expect(firstCall?.[1]).toEqual({
      workspaceId: "workspace_1",
      pageId: "page_1",
      snapshot: '{"type":"doc"}',
      version: 42,
    });
  });
});
