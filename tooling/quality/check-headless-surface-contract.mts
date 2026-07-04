import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { confectManifest } from "../../packages/template-core/src/generated/confectManifest";
import { descriptorFor } from "./src/check-definitions.mts";
import { isDirectRun } from "./src/direct-run.mts";
import { evaluateStaticCheck } from "./src/gate.mts";

export const descriptor = descriptorFor("headless-surface-contract");

const externalSurfaces = ["api", "cli", "mcp"] as const;
type ExternalSurface = (typeof externalSurfaces)[number];

type Surface = ExternalSurface | "web" | "workflow" | "internal" | string;

export type HeadlessManifestOperation = {
  readonly operationId: string;
  readonly surfaces: readonly Surface[];
  readonly typedErrors: readonly string[];
  readonly kind?: string;
  readonly idempotent?: boolean;
};

const hasExternalSurface = (operation: HeadlessManifestOperation): boolean =>
  operation.surfaces.some((surface) =>
    externalSurfaces.includes(surface as ExternalSurface),
  );

const exposedOperationIds = (
  operations: readonly HeadlessManifestOperation[],
  surface: ExternalSurface,
): string[] =>
  operations
    .filter((operation) => operation.surfaces.includes(surface))
    .map((operation) => operation.operationId);

export const missingTypedErrors = (
  operations: readonly HeadlessManifestOperation[],
): string[] =>
  operations
    .filter(
      (operation) =>
        hasExternalSurface(operation) && operation.typedErrors.length === 0,
    )
    .map((operation) => operation.operationId);

export const cannedRegistryImport = (source: string): string[] => {
  const forbiddenImport =
    /import\s*\{[^}]*\btemplateRegistry\b[^}]*\}\s*from\s*["']@maestro-template\/template-core["']/m;
  return forbiddenImport.test(source) ? ["templateRegistry"] : [];
};

export const cannedRuntimeSuccess = (source: string): string[] => {
  const markers = [
    /\baccepted\s*:\s*true\b/,
    /\bok\s*:\s*true\s*,\s*result\s*:\s*\{[^}]*\}/s,
  ] as const;

  return markers.some((marker) => marker.test(source)) ? ["accepted"] : [];
};

export const missingGeneratedRefMapping = (
  operationIds: readonly string[],
  source: string,
): string[] =>
  operationIds.filter(
    (operationId) =>
      !source.includes(`"${operationId}"`) &&
      !source.includes(`'${operationId}'`) &&
      !source.includes(`\`${operationId}\``),
  );

const missingIdempotencyProof = (
  operations: readonly HeadlessManifestOperation[],
  source: string,
): string[] =>
  operations
    .filter(
      (operation) =>
        hasExternalSurface(operation) &&
        operation.idempotent === false &&
        ["mutation", "action"].includes(operation.kind ?? ""),
    )
    .filter(
      (operation) =>
        !source.includes(
          `Operation ${operation.operationId} requires a nonblank idempotencyKey.`,
        ),
    )
    .map((operation) => operation.operationId);

const readRepoFile = async (repoRoot: string, path: string): Promise<string> =>
  readFile(join(repoRoot, path), "utf8");

export const evaluateHeadlessSurfaceContract = async (
  repoRoot: string,
): Promise<readonly string[]> => {
  const staticResult = await evaluateStaticCheck(repoRoot, descriptor);
  const failures = [...staticResult.failures];
  const operations =
    confectManifest.functions as readonly HeadlessManifestOperation[];

  const [
    httpSource,
    cliSource,
    workflowSource,
    mcpSource,
    executorSource,
    httpTests,
    executorTests,
    workflowTests,
    confectGuide,
  ] = await Promise.all([
    readRepoFile(repoRoot, "packages/convex/confect/http.ts"),
    readRepoFile(repoRoot, "apps/cli/src/index.ts"),
    readRepoFile(repoRoot, "tooling/workflow/src/index.ts"),
    readRepoFile(repoRoot, "packages/convex/confect/manifest/mcp.ts"),
    readRepoFile(repoRoot, "packages/convex/confect/manifest/executor.ts"),
    readRepoFile(repoRoot, "packages/convex/test/http-docs.test.ts"),
    readRepoFile(repoRoot, "packages/convex/test/headless-executor.test.ts"),
    readRepoFile(repoRoot, "tooling/workflow/src/index.test.ts"),
    readRepoFile(repoRoot, "docs/template/confect-effect-guide.md"),
  ]);

  for (const operationId of missingTypedErrors(operations)) {
    failures.push(
      `operation ${operationId} is exposed to API/CLI/MCP without public typed errors`,
    );
  }

  for (const operationId of missingIdempotencyProof(
    operations,
    [
      httpSource,
      executorSource,
      httpTests,
      executorTests,
      workflowTests,
      confectGuide,
    ].join("\n"),
  )) {
    failures.push(
      `operation ${operationId} is non-idempotent on API/CLI/MCP without idempotency-key enforcement proof`,
    );
  }

  const apiMissingRefs = missingGeneratedRefMapping(
    exposedOperationIds(operations, "api"),
    httpSource,
  );
  const cliMissingRefs = missingGeneratedRefMapping(
    exposedOperationIds(operations, "cli"),
    cliSource,
  );
  const mcpMissingRefs = missingGeneratedRefMapping(
    exposedOperationIds(operations, "mcp"),
    `${workflowSource}\n${mcpSource}`,
  );

  for (const operationId of apiMissingRefs) {
    failures.push(
      `API operation ${operationId} lacks a generated ref mapping in packages/convex/confect/http.ts`,
    );
  }
  for (const operationId of cliMissingRefs) {
    failures.push(
      `CLI operation ${operationId} lacks a generated ref mapping in apps/cli/src/index.ts`,
    );
  }
  for (const operationId of mcpMissingRefs) {
    failures.push(
      `MCP operation ${operationId} lacks a generated ref mapping in the MCP projection`,
    );
  }

  for (const marker of cannedRuntimeSuccess(
    [httpSource, cliSource, workflowSource, executorSource].join("\n"),
  )) {
    failures.push(
      `runtime executor code returns canned success marker ${marker} instead of executeHeadlessOperation`,
    );
  }

  for (const marker of cannedRegistryImport(workflowSource)) {
    failures.push(
      `tooling/workflow/src/index.ts imports forbidden canned registry ${marker}`,
    );
  }
  for (const marker of cannedRegistryImport(cliSource)) {
    failures.push(
      `apps/cli/src/index.ts imports forbidden canned registry ${marker}`,
    );
  }

  if (httpSource.includes("@maestro-template/workflow-tooling")) {
    failures.push(
      "packages/convex/confect/http.ts must not import @maestro-template/workflow-tooling",
    );
  }

  return failures;
};

export const runHeadlessSurfaceContractCheck = async (
  repoRoot = process.cwd(),
): Promise<void> => {
  const failures = await evaluateHeadlessSurfaceContract(repoRoot);
  if (failures.length === 0) {
    console.log(`${descriptor.name}: ok`);
    return;
  }

  for (const failure of failures) {
    console.error(`${descriptor.name}: ${failure}`);
  }
  process.exitCode = 1;
};

if (isDirectRun(import.meta.url)) await runHeadlessSurfaceContractCheck();
