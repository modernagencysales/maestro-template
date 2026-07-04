import { confectManifest } from "@maestro-template/template-core/generated/confectManifest";

type JsonSchema = {
  readonly type?: string;
  readonly properties?: Record<string, JsonSchema>;
  readonly required?: readonly string[];
  readonly enum?: readonly string[];
  readonly additionalProperties?: boolean;
};

const objectSchema: JsonSchema = {
  type: "object",
  additionalProperties: true,
};

export const buildGeneratedOpenApiDocument = () => ({
  openapi: "3.1.0" as const,
  info: {
    title: "Maestro Template Headless API",
    version: "0.1.0",
    description: "Generated from Confect contract manifest metadata.",
  },
  paths: Object.fromEntries(
    confectManifest.functions
      .filter((entry) => (entry.surfaces as readonly string[]).includes("api"))
      .map((entry) => [
        `/api/${entry.operationId}`,
        {
          post: {
            operationId: entry.operationId,
            tags: ["template-headless"],
            "x-maestro-typed-errors": entry.typedErrors,
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: objectSchema,
                },
              },
            },
            responses: {
              "200": { description: "Typed operation result." },
              "400": { description: "Declared typed failure." },
            },
          },
        },
      ]),
  ),
});
