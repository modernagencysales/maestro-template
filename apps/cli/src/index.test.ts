import { describe, expect, it } from "vitest";
import { runCli } from "./index";

describe("maestro-template CLI", () => {
  it("describes the shared workflow template", () => {
    const result = runCli(["describe"]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      valid: true,
      capabilityCount: 4,
      headlessOperationCount: 11,
    });
  });

  it("lists and gets headless operations", () => {
    const list = runCli(["operations", "list"]);
    const operations = JSON.parse(list.stdout);
    const get = runCli(["operations", "get", "api:brain.pages.createMarkdown"]);

    expect(operations).toHaveLength(11);
    expect(
      operations.map((operation: { id: string }) => operation.id),
    ).toContain("api:brain.pages.createMarkdown");
    expect(
      operations.map((operation: { id: string }) => operation.id),
    ).not.toContain("CLI:createTrustReceipt");
    expect(JSON.parse(get.stdout)).toMatchObject({
      surface: "api",
      capability: "brain.pages.createMarkdown",
      authScope: "workspace member",
    });
  });

  it("prints API and MCP metadata", () => {
    expect(JSON.parse(runCli(["api", "catalog"]).stdout)).toContainEqual(
      expect.objectContaining({
        operationId: "brain.pages.createMarkdown",
        path: "/api/brain.pages.createMarkdown",
      }),
    );
    expect(JSON.parse(runCli(["api", "catalog"]).stdout)).not.toContainEqual(
      expect.objectContaining({
        operationId: "resolveSourceSet",
      }),
    );
    expect(JSON.parse(runCli(["api", "openapi"]).stdout)).toMatchObject({
      openapi: "3.1.0",
      paths: {
        "/api/brain.pages.createMarkdown": {
          post: {
            operationId: "brain.pages.createMarkdown",
            "x-maestro-auth-scope": "workspace member",
            "x-maestro-typed-errors": [
              "Unauthorized",
              "MemberNotInWorkspace",
              "WorkspaceNotFound",
            ],
          },
        },
      },
    });
    expect(JSON.parse(runCli(["mcp", "tools"]).stdout)).toContainEqual(
      expect.objectContaining({
        name: "template.brain.pages.createMarkdown",
        inputSchema: expect.objectContaining({ type: "object" }),
      }),
    );
    expect(JSON.parse(runCli(["mcp", "tools"]).stdout)).not.toContainEqual(
      expect.objectContaining({ name: "template.resolveSourceSet" }),
    );
  });

  it("calls MCP tools through the shared workflow registry", () => {
    const result = runCli(["mcp", "call", "template.workflow.run"]);
    const call = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(call.isError).toBe(false);
    expect(JSON.parse(call.content[0].text)).toMatchObject({
      runId: "run_template_001",
      workflowRunId: "run_template_001",
      trustReceiptId: "trust_run_template_001",
      trustReceipt: {
        receiptId: "trust_run_template_001",
      },
    });
  });

  it("prints integration readiness without requiring live secrets", () => {
    const report = JSON.parse(
      runCli(["integrations", "report", "fake"]).stdout,
    );

    expect(report).toContainEqual(
      expect.objectContaining({
        id: "workos",
        displayName: "WorkOS/AuthKit",
        mode: "fake",
        ready: true,
      }),
    );
  });

  it("runs the sample workflow and prints a trust receipt", () => {
    const receipt = JSON.parse(runCli(["workflow", "run"]).stdout);

    expect(receipt).toMatchObject({
      runId: "run_template_001",
      workflowRunId: "run_template_001",
      trustReceiptId: "trust_run_template_001",
      status: "completed",
      trustReceipt: {
        receiptId: "trust_run_template_001",
      },
    });
  });

  it("runs the source-grounded brief capability from the CLI", () => {
    const result = runCli(["capability", "run", "brain.pages.createMarkdown"]);
    const payload = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(1);
    expect(payload).toMatchObject({
      ok: false,
      error: {
        _tag: "FeatureDisabled",
        message:
          "Operation brain.pages.createMarkdown requires a runtime execution adapter.",
      },
    });
  });

  it("returns a clear error for unknown operations", () => {
    const result = runCli(["operations", "get", "cli:nope"]);

    expect(result).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "Unknown operation: cli:nope\n",
    });
  });
});
