export type ContractFunctionKind = "query" | "mutation" | "action";
export type ContractSurface =
  "api" | "cli" | "mcp" | "web" | "workflow" | "internal";

export type ContractFunctionManifest = {
  readonly namespace: string;
  readonly name: string;
  readonly operationId: string;
  readonly kind: ContractFunctionKind;
  readonly surfaces: readonly ContractSurface[];
  readonly typedErrors: readonly string[];
  readonly idempotent: boolean;
  readonly argsSchemaName: string;
  readonly returnsSchemaName: string;
};

export type ContractManifest = {
  readonly version: 1;
  readonly generatedAt: string;
  readonly functions: readonly ContractFunctionManifest[];
};

export const buildContractManifest = (
  functions: readonly ContractFunctionManifest[],
  generatedAt = "1970-01-01T00:00:00.000Z",
): ContractManifest => ({
  version: 1,
  generatedAt,
  functions: [...functions].sort((left, right) =>
    left.operationId.localeCompare(right.operationId),
  ),
});

export const manifestOperationIds = (
  manifest: ContractManifest,
): readonly string[] => manifest.functions.map((entry) => entry.operationId);
