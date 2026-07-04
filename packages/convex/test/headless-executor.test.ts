import { describe, expect, it } from "vitest";
import {
  executeHeadlessOperation,
  findHeadlessOperation,
  type HeadlessExecutionAdapter,
} from "../confect/manifest/executor";

const createAdapter = (
  overrides: Partial<HeadlessExecutionAdapter> = {},
): HeadlessExecutionAdapter => ({
  refs: {
    "brain.pages.createMarkdown": "brain.pages.createMarkdown.ref",
  },
  runQuery: async () => {
    throw new Error("runQuery should not be called");
  },
  runMutation: async () => "brainPage_123",
  runAction: async () => {
    throw new Error("runAction should not be called");
  },
  ...overrides,
});

describe("headless executor", () => {
  it("does not expose web-only operations on headless API surfaces", () => {
    expect(findHeadlessOperation("brain.pages.list", "api")).toBeUndefined();
  });

  it("requires idempotency keys for non-idempotent headless writes", async () => {
    const result = await executeHeadlessOperation(createAdapter(), {
      operationId: "brain.pages.createMarkdown",
      surface: "api",
      input: { title: "A note" },
    });

    expect(result).toEqual({
      ok: false,
      error: {
        _tag: "ValidationFailed",
        message:
          "Operation brain.pages.createMarkdown requires a nonblank idempotencyKey.",
      },
    });
  });

  it("dispatches exposed writes through the adapter ref with idempotency input", async () => {
    const calls: unknown[] = [];
    const adapter = createAdapter({
      runMutation: async (ref, input) => {
        calls.push([ref, input]);
        return { id: "brainPage_123" };
      },
    });

    const result = await executeHeadlessOperation(adapter, {
      operationId: "brain.pages.createMarkdown",
      surface: "api",
      input: { title: "A note" },
      idempotencyKey: "idem_123",
    });

    expect(calls).toEqual([
      [
        "brain.pages.createMarkdown.ref",
        { title: "A note", idempotencyKey: "idem_123" },
      ],
    ]);
    expect(result).toEqual({
      ok: true,
      operationId: "brain.pages.createMarkdown",
      result: { id: "brainPage_123" },
    });
  });

  it("fails when an exposed operation has no adapter ref", async () => {
    const result = await executeHeadlessOperation(createAdapter({ refs: {} }), {
      operationId: "brain.pages.createMarkdown",
      surface: "api",
      input: {},
      idempotencyKey: "idem_123",
    });

    expect(result).toEqual({
      ok: false,
      error: {
        _tag: "NotFound",
        message:
          "No generated function ref registered for operation brain.pages.createMarkdown.",
      },
    });
  });

  it("rejects non-JSON-safe adapter results", async () => {
    const result = await executeHeadlessOperation(
      createAdapter({
        runMutation: async () => undefined,
      }),
      {
        operationId: "brain.pages.createMarkdown",
        surface: "api",
        input: {},
        idempotencyKey: "idem_123",
      },
    );

    expect(result).toEqual({
      ok: false,
      error: {
        _tag: "ValidationFailed",
        message:
          "Operation brain.pages.createMarkdown returned a non-JSON-safe result.",
      },
    });
  });
});
