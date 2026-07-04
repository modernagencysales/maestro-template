import {
  createSampleWorkflowRunReceipt,
  templateRegistry,
  validateTemplateRegistry,
  type TemplateRegistry,
  type WorkflowRunReceipt,
} from "@maestro-template/template-core";
import { confectManifest } from "@maestro-template/template-core/generated/confectManifest";

type ManifestFunction = (typeof confectManifest.functions)[number];
type ManifestSurface = ManifestFunction["surfaces"][number];

const hasSurface = (
  entry: ManifestFunction,
  surface: string,
): surface is ManifestSurface =>
  (entry.surfaces as readonly string[]).includes(surface);

export type HeadlessOperation = {
  readonly id: string;
  readonly surface: ManifestSurface;
  readonly capability: ManifestFunction["operationId"];
  readonly route: string;
  readonly authScope: string;
  readonly typedErrors: readonly string[];
};

export type ApiCatalogEntry = {
  readonly operationId: string;
  readonly method: "POST";
  readonly path: string;
  readonly authScope: string;
  readonly typedErrors: readonly string[];
};

export type TemplateApiRequest = {
  readonly workspaceSlug?: string;
  readonly input?: Record<string, unknown>;
  readonly idempotencyKey?: string;
};

export type TemplateApiResult =
  | {
      readonly ok: true;
      readonly operationId: string;
      readonly result: Record<string, unknown>;
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly _tag:
          "NotFound" | "ValidationFailed" | "Unauthorized" | "FeatureDisabled";
        readonly message: string;
      };
    };

type JsonSchema = {
  readonly type?: string;
  readonly description?: string;
  readonly properties?: Record<string, JsonSchema>;
  readonly required?: readonly string[];
  readonly items?: JsonSchema;
  readonly enum?: readonly string[];
  readonly additionalProperties?: boolean;
};

export type OpenApiDocument = {
  readonly openapi: "3.1.0";
  readonly info: {
    readonly title: string;
    readonly version: string;
    readonly description: string;
  };
  readonly paths: Record<
    string,
    {
      readonly post: {
        readonly operationId: string;
        readonly summary: string;
        readonly description: string;
        readonly tags: readonly string[];
        readonly security: readonly {
          readonly bearerAuth: readonly string[];
        }[];
        readonly "x-maestro-auth-scope": string;
        readonly "x-maestro-typed-errors": readonly string[];
        readonly requestBody: {
          readonly required: true;
          readonly content: {
            readonly "application/json": {
              readonly schema: JsonSchema;
              readonly example: Record<string, unknown>;
            };
          };
        };
        readonly responses: Record<
          string,
          {
            readonly description: string;
            readonly content: {
              readonly "application/json": {
                readonly schema: JsonSchema;
                readonly examples?: Record<
                  string,
                  { readonly value: Record<string, unknown> }
                >;
              };
            };
          }
        >;
      };
    }
  >;
  readonly components: {
    readonly securitySchemes: {
      readonly bearerAuth: {
        readonly type: "http";
        readonly scheme: "bearer";
      };
    };
    readonly schemas: Record<string, JsonSchema>;
  };
};

export type McpToolEntry = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly typedErrors: readonly string[];
};

export type McpToolCallResult = {
  readonly isError: boolean;
  readonly content: readonly {
    readonly type: "text";
    readonly text: string;
  }[];
};

export const buildHeadlessOperations = (
  _registry: TemplateRegistry = templateRegistry,
): readonly HeadlessOperation[] =>
  confectManifest.functions.flatMap((entry) =>
    entry.surfaces.map((surface) => ({
      id: `${surface}:${entry.operationId}`,
      surface,
      capability: entry.operationId,
      route:
        surface === "api" ? `/api/${entry.operationId}` : entry.operationId,
      authScope: "workspace member",
      typedErrors: entry.typedErrors,
    })),
  );

export const describeWorkflowTemplate = (
  registry: TemplateRegistry = templateRegistry,
) => {
  const validationErrors = validateTemplateRegistry(registry);

  return {
    valid: validationErrors.length === 0,
    validationErrors,
    nodeCount: registry.workflow.nodes.length,
    edgeCount: registry.workflow.edges.length,
    capabilityCount: confectManifest.functions.length,
    agentCount: registry.agents.length,
    headlessOperationCount: buildHeadlessOperations(registry).length,
  };
};

export const getHeadlessOperation = (
  id: string,
  registry: TemplateRegistry = templateRegistry,
): HeadlessOperation | undefined =>
  buildHeadlessOperations(registry).find((operation) => operation.id === id);

export const buildApiCatalog = (
  _registry: TemplateRegistry = templateRegistry,
): readonly ApiCatalogEntry[] =>
  confectManifest.functions
    .filter((entry) => hasSurface(entry, "api"))
    .map((entry) => ({
      operationId: entry.operationId,
      method: "POST",
      path: `/api/${entry.operationId}`,
      authScope: "workspace member",
      typedErrors: entry.typedErrors,
    }));

const baseRequestSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["workspaceSlug", "input"],
  properties: {
    workspaceSlug: {
      type: "string",
      description: "Server-authorized workspace slug or instance alias.",
    },
    input: {
      type: "object",
      description:
        "Capability-specific input. Generated Confect refs provide the exact Effect schema in the implementation package.",
      additionalProperties: true,
    },
    idempotencyKey: {
      type: "string",
      description: "Required for externally visible writes.",
    },
  },
};

const successResponseSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ok", "operationId", "result"],
  properties: {
    ok: { type: "boolean" },
    operationId: { type: "string" },
    result: {
      type: "object",
      description:
        "Typed capability result encoded by the generated Confect function.",
      additionalProperties: true,
    },
  },
};

const typedErrorSchema = (typedErrors: readonly string[]): JsonSchema => ({
  type: "object",
  additionalProperties: false,
  required: ["ok", "error"],
  properties: {
    ok: { type: "boolean" },
    error: {
      type: "object",
      additionalProperties: false,
      required: ["_tag", "message"],
      properties: {
        _tag: {
          type: "string",
          enum: typedErrors,
          description: "Declared public typed error variant.",
        },
        message: {
          type: "string",
          description: "Redacted user-safe error message.",
        },
      },
    },
  },
});

const mcpInputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    workspaceSlug: {
      type: "string",
      description: "Reviewer-safe workspace slug. Defaults to acme-demo.",
    },
  },
};

const apiExampleFor = (
  entry: ApiCatalogEntry,
): {
  readonly request: Record<string, unknown>;
  readonly success: Record<string, unknown>;
  readonly typedError: Record<string, unknown>;
} => ({
  request: {
    workspaceSlug: "acme-demo",
    input: {
      sample: entry.operationId,
    },
    idempotencyKey: `${entry.operationId}-example-001`,
  },
  success: {
    ok: true,
    operationId: entry.operationId,
    result: {
      status: "accepted",
      id: "generated_result_example",
    },
  },
  typedError: {
    ok: false,
    error: {
      _tag: entry.typedErrors[0] ?? "ValidationFailed",
      message: "Request failed a declared template policy check.",
    },
  },
});

export const buildOpenApiDocument = (
  registry: TemplateRegistry = templateRegistry,
): OpenApiDocument => {
  const apiEntries = buildApiCatalog(registry);

  return {
    openapi: "3.1.0",
    info: {
      title: "Maestro Template Headless API",
      version: "0.1.0",
      description:
        "Generated from the Confect manifest. The live Confect HTTP implementation mounts the same operations for Scalar.",
    },
    paths: Object.fromEntries(
      apiEntries.map((entry) => {
        const examples = apiExampleFor(entry);

        return [
          entry.path,
          {
            post: {
              operationId: entry.operationId,
              summary: `Run ${entry.operationId}`,
              description:
                "Calls the same typed capability/workflow contract used by the web, CLI, and MCP surfaces.",
              tags: ["template-headless"],
              security: [{ bearerAuth: [entry.authScope] }],
              "x-maestro-auth-scope": entry.authScope,
              "x-maestro-typed-errors": entry.typedErrors,
              requestBody: {
                required: true,
                content: {
                  "application/json": {
                    schema: baseRequestSchema,
                    example: examples.request,
                  },
                },
              },
              responses: {
                "200": {
                  description: "Typed capability result.",
                  content: {
                    "application/json": {
                      schema: successResponseSchema,
                      examples: {
                        success: { value: examples.success },
                      },
                    },
                  },
                },
                "400": {
                  description: "Declared typed failure.",
                  content: {
                    "application/json": {
                      schema: typedErrorSchema(entry.typedErrors),
                      examples: {
                        typedError: { value: examples.typedError },
                      },
                    },
                  },
                },
              },
            },
          },
        ];
      }),
    ),
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
        },
      },
      schemas: {
        TemplateOperationRequest: baseRequestSchema,
        TemplateOperationSuccess: successResponseSchema,
      },
    },
  };
};

export const runTemplateApiOperation = (
  operationId: string,
  request: TemplateApiRequest = {},
  _registry: TemplateRegistry = templateRegistry,
): TemplateApiResult => {
  const operation = buildApiCatalog(_registry).find(
    (entry) => entry.operationId === operationId,
  );

  if (!operation) {
    return {
      ok: false,
      error: {
        _tag: "NotFound",
        message: `Unknown template API operation: ${operationId}`,
      },
    };
  }

  const workspaceSlug = request.workspaceSlug?.trim() || "acme-demo";

  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(workspaceSlug)) {
    return {
      ok: false,
      error: {
        _tag: "ValidationFailed",
        message: "workspaceSlug must be a lowercase slug.",
      },
    };
  }

  const manifestEntry = confectManifest.functions.find(
    (entry) => entry.operationId === operationId,
  );

  if (
    manifestEntry &&
    !manifestEntry.idempotent &&
    !request.idempotencyKey?.trim()
  ) {
    return {
      ok: false,
      error: {
        _tag: "ValidationFailed",
        message: `Operation ${operationId} requires a nonblank idempotencyKey.`,
      },
    };
  }

  return {
    ok: false,
    error: {
      _tag: "FeatureDisabled",
      message: `Operation ${operationId} requires a runtime execution adapter.`,
    },
  };
};

export const buildMcpTools = (
  _registry: TemplateRegistry = templateRegistry,
): readonly McpToolEntry[] => [
  ...buildHeadlessOperations()
    .filter((operation) => operation.surface === "mcp")
    .map((operation) => ({
      name: `template.${operation.capability}`,
      description: `Invoke ${operation.capability} through the generated manifest.`,
      inputSchema: mcpInputSchema,
      typedErrors: operation.typedErrors,
    })),
  {
    name: "template.workflow.run",
    description:
      "Run the deterministic reviewer-safe workflow through the shared template registry.",
    inputSchema: mcpInputSchema,
    typedErrors: ["Unauthorized", "ValidationFailed"],
  },
];

export const runTemplateWorkflow = (
  registry: TemplateRegistry = templateRegistry,
): WorkflowRunReceipt => createSampleWorkflowRunReceipt(registry);

const mcpText = (value: unknown): McpToolCallResult => ({
  isError: false,
  content: [
    {
      type: "text",
      text: JSON.stringify(value, null, 2),
    },
  ],
});

const mcpError = (message: string): McpToolCallResult => ({
  isError: true,
  content: [
    {
      type: "text",
      text: JSON.stringify(
        {
          ok: false,
          error: {
            _tag: "ToolNotFound",
            message,
          },
        },
        null,
        2,
      ),
    },
  ],
});

export const callMcpTool = (
  toolName: string,
  registry: TemplateRegistry = templateRegistry,
): McpToolCallResult => {
  if (toolName === "template.workflow.run") {
    return mcpText(runTemplateWorkflow(registry));
  }

  const operation = confectManifest.functions.find(
    (candidate) =>
      hasSurface(candidate, "mcp") &&
      `template.${candidate.operationId}` === toolName,
  );

  if (!operation) {
    return mcpError(`Unknown MCP tool: ${toolName}`);
  }

  return mcpText({
    ok: false,
    toolName,
    capability: operation.operationId,
    typedErrors: operation.typedErrors,
    error: {
      _tag: "FeatureDisabled",
      message: `MCP operation ${operation.operationId} requires a runtime execution adapter.`,
    },
  });
};
