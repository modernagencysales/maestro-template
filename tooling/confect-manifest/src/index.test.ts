import { describe, expect, it } from "vitest";
import { buildContractManifest, manifestOperationIds } from "./index";

describe("confect manifest tooling", () => {
  it("sorts operation ids for deterministic output", () => {
    const manifest = buildContractManifest([
      {
        namespace: "b",
        name: "run",
        operationId: "b.run",
        kind: "mutation",
        surfaces: ["api"],
        typedErrors: ["Unauthorized"],
        idempotent: false,
        argsSchemaName: "b.run.args",
        returnsSchemaName: "b.run.returns",
      },
      {
        namespace: "a",
        name: "list",
        operationId: "a.list",
        kind: "query",
        surfaces: ["web"],
        typedErrors: ["WorkspaceNotFound"],
        idempotent: true,
        argsSchemaName: "a.list.args",
        returnsSchemaName: "a.list.returns",
      },
    ]);

    expect(manifestOperationIds(manifest)).toEqual(["a.list", "b.run"]);
  });
});
