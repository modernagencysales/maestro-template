import {
  confectJsonSchemas,
  confectManifest,
} from "@maestro-template/template-core/generated/confectManifest";

const openApiRequestSchemaFor = (schemaName: string): unknown => {
  const schema =
    confectJsonSchemas.openApi31[
      schemaName as keyof typeof confectJsonSchemas.openApi31
    ];

  if (schema === undefined) {
    throw new Error(`Missing OpenAPI JSON schema for ${schemaName}.`);
  }

  return schema;
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
                  schema: openApiRequestSchemaFor(entry.argsSchemaName),
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
