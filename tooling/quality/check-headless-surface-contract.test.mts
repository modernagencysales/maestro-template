import { describe, expect, it } from "vitest";
import { expectDescriptorPassesAndFails } from "./src/check-test-helpers.mts";
import {
  cannedRegistryImport,
  cannedRuntimeSuccess,
  descriptor,
  missingGeneratedRefMapping,
  missingTypedErrors,
} from "./check-headless-surface-contract.mts";

describe("check:headless-surface-contract", () => {
  it("passes and fails on its declared requirements", async () => {
    await expectDescriptorPassesAndFails(descriptor);
  });

  it("reports exposed manifest operations without typed errors", () => {
    expect(
      missingTypedErrors([
        { operationId: "x", surfaces: ["api"], typedErrors: [] },
      ]),
    ).toContain("x");

    expect(
      missingTypedErrors([
        { operationId: "internal.x", surfaces: ["internal"], typedErrors: [] },
        { operationId: "web.x", surfaces: ["web"], typedErrors: [] },
        {
          operationId: "api.x",
          surfaces: ["api"],
          typedErrors: ["ValidationFailed"],
        },
      ]),
    ).toEqual([]);
  });

  it("reports forbidden registry imports on generated surfaces", () => {
    expect(
      cannedRegistryImport(
        'import { templateRegistry } from "@maestro-template/template-core";',
      ),
    ).toContain("templateRegistry");

    expect(
      cannedRegistryImport(
        'import { confectManifest } from "@maestro-template/template-core/generated/confectManifest";',
      ),
    ).toEqual([]);
  });

  it("reports canned runtime success markers", () => {
    expect(
      cannedRuntimeSuccess("return { ok: true, result: { accepted: true } };"),
    ).toContain("accepted");

    expect(
      cannedRuntimeSuccess(
        "return executeHeadlessOperation(adapter, request);",
      ),
    ).toEqual([]);
  });

  it("reports missing generated ref mappings", () => {
    expect(
      missingGeneratedRefMapping(["brain.pages.createMarkdown"], "{}"),
    ).toContain("brain.pages.createMarkdown");

    expect(
      missingGeneratedRefMapping(
        ["brain.pages.createMarkdown"],
        '{"brain.pages.createMarkdown": api.brain.pages.createMarkdown}',
      ),
    ).toEqual([]);
  });
});
