import { confectManifest } from "@maestro-template/template-core/generated/confectManifest";

export const buildGeneratedMcpTools = () =>
  confectManifest.functions
    .filter((entry) => (entry.surfaces as readonly string[]).includes("mcp"))
    .map((entry) => ({
      name: `template.${entry.operationId}`,
      description: `Invoke ${entry.operationId} through the generated Confect contract manifest.`,
      inputSchema: {
        type: "object",
        additionalProperties: true,
      },
      typedErrors: entry.typedErrors,
    }));
