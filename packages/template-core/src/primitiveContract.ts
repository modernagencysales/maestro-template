export type PrimitiveSurface =
  "web" | "api" | "cli" | "mcp" | "workflow" | "internal";

export type PrimitiveRuntime =
  | "domain"
  | "confect-query"
  | "confect-mutation"
  | "confect-action"
  | "convex-workflow"
  | "frontend-view-model"
  | "editor";

export type PrimitiveFileKind =
  | "domain"
  | "schema"
  | "spec"
  | "impl"
  | "workflow-handler"
  | "frontend-state"
  | "frontend-adapter"
  | "manifest"
  | "test"
  | "docs"
  | "quality-gate";

export type PrimitiveContractFile = {
  readonly path: string;
  readonly kind: PrimitiveFileKind;
};

export type PrimitiveContract = {
  readonly name: string;
  readonly namespace: string;
  readonly version: number;
  readonly runtimes: readonly PrimitiveRuntime[];
  readonly surfaces: readonly PrimitiveSurface[];
  readonly hasInternalWorkflowStep: boolean;
  readonly uiStates: readonly string[];
  readonly files: readonly PrimitiveContractFile[];
};

export type PrimitiveContractFinding = {
  readonly field: "name" | "namespace" | "version" | "files";
  readonly message: string;
};

export const createPrimitiveContract = (
  contract: PrimitiveContract,
): PrimitiveContract => contract;

export const checkPrimitiveContract = (
  contract: PrimitiveContract,
): readonly PrimitiveContractFinding[] => {
  const findings: PrimitiveContractFinding[] = [];
  const fileKinds = new Set(contract.files.map((file) => file.kind));
  const hasConfectRuntime = contract.runtimes.some((runtime) =>
    runtime.startsWith("confect-"),
  );

  if (contract.name.trim().length === 0) {
    findings.push({ field: "name", message: "Primitive name is required." });
  }

  if (contract.namespace.trim().length === 0) {
    findings.push({
      field: "namespace",
      message: "Primitive namespace is required.",
    });
  }

  if (contract.version < 1) {
    findings.push({
      field: "version",
      message: "Primitive version must be at least 1.",
    });
  }

  if (!fileKinds.has("domain") && !fileKinds.has("frontend-state")) {
    findings.push({
      field: "files",
      message: "Each primitive needs a pure domain or view-model file.",
    });
  }

  if (hasConfectRuntime && (!fileKinds.has("spec") || !fileKinds.has("impl"))) {
    findings.push({
      field: "files",
      message: "Confect primitives need both spec and impl files.",
    });
  }

  if (contract.surfaces.length > 0 && !fileKinds.has("manifest")) {
    findings.push({
      field: "files",
      message: "Exposed primitives need manifest metadata.",
    });
  }

  if (contract.hasInternalWorkflowStep && !fileKinds.has("workflow-handler")) {
    findings.push({
      field: "files",
      message:
        "Workflow-step primitives need a workflow handler or dispatch file.",
    });
  }

  if (contract.uiStates.length > 0 && !fileKinds.has("frontend-state")) {
    findings.push({
      field: "files",
      message: "UI-visible primitives need a frontend state file.",
    });
  }

  return findings;
};
