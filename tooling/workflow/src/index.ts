import {
  type TemplateRegistry,
  type WorkflowRunReceipt,
} from "@maestro-template/template-core";
import { confectManifest } from "@maestro-template/template-core/generated/confectManifest";
import {
  describeDefaultWorkflow,
  describeWorkflowRegistry,
  runDefaultWorkflow,
  runWorkflowRegistry,
} from "./workflow-compat";

type ManifestFunction = (typeof confectManifest.functions)[number];
type ManifestSurface = ManifestFunction["surfaces"][number];

const hasSurface = (
  entry: ManifestFunction,
  surface: string,
): surface is ManifestSurface =>
  (entry.surfaces as readonly string[]).includes(surface);

export const generatedCliOperationRefs: Readonly<Record<string, string>> = {
  "brain.pages.createMarkdown": "brain.pages.createMarkdown",
};

export const generatedMcpOperationRefs: Readonly<Record<string, string>> = {
  "brain.pages.createMarkdown": "template.brain.pages.createMarkdown",
};

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
        readonly tags: readonly string[];
        readonly "x-maestro-auth-scope"?: string;
        readonly "x-maestro-typed-errors": readonly string[];
        readonly requestBody: {
          readonly required: true;
          readonly content: {
            readonly "application/json": {
              readonly schema: JsonSchema;
            };
          };
        };
        readonly responses: Record<
          string,
          {
            readonly description: string;
          }
        >;
      };
    }
  >;
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
  _registry?: TemplateRegistry,
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

export const describeWorkflowTemplate = (registry?: TemplateRegistry) =>
  registry === undefined
    ? describeDefaultWorkflow(
        confectManifest.functions.length,
        buildHeadlessOperations().length,
      )
    : describeWorkflowRegistry(
        registry,
        confectManifest.functions.length,
        buildHeadlessOperations(registry).length,
      );

export const getHeadlessOperation = (
  id: string,
  registry?: TemplateRegistry,
): HeadlessOperation | undefined =>
  buildHeadlessOperations(registry).find((operation) => operation.id === id);

export const buildApiCatalog = (
  _registry?: TemplateRegistry,
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

const objectSchema: JsonSchema = {
  type: "object",
  additionalProperties: true,
};

export const buildGeneratedOpenApiDocument = (
  _registry?: TemplateRegistry,
): OpenApiDocument => {
  return {
    openapi: "3.1.0",
    info: {
      title: "Maestro Template Headless API",
      version: "0.1.0",
      description: "Generated from Confect contract manifest metadata.",
    },
    paths: Object.fromEntries(
      confectManifest.functions
        .filter((entry) => hasSurface(entry, "api"))
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
                "200": {
                  description: "Typed operation result.",
                },
                "400": {
                  description: "Declared typed failure.",
                },
              },
            },
          },
        ]),
    ),
  };
};

export const buildOpenApiDocument = buildGeneratedOpenApiDocument;

export const runTemplateApiOperation = (
  operationId: string,
  request: TemplateApiRequest = {},
  _registry?: TemplateRegistry,
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

export const buildGeneratedMcpTools = (
  _registry?: TemplateRegistry,
): readonly McpToolEntry[] =>
  confectManifest.functions
    .filter((entry) => hasSurface(entry, "mcp"))
    .map((entry) => ({
      name:
        generatedMcpOperationRefs[entry.operationId] ??
        `template.${entry.operationId}`,
      description: `Invoke ${entry.operationId} through the generated Confect contract manifest.`,
      inputSchema: mcpInputSchema,
      typedErrors: entry.typedErrors,
    }));

const mcpInputSchema: JsonSchema = {
  type: "object",
  additionalProperties: true,
};

const workflowRunMcpTool: McpToolEntry = {
  name: "template.workflow.run",
  description: "Run the template workflow compatibility adapter.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
  },
  typedErrors: [],
};

export const buildMcpTools = (
  registry?: TemplateRegistry,
): readonly McpToolEntry[] => [
  ...buildGeneratedMcpTools(registry),
  workflowRunMcpTool,
];

export const runTemplateWorkflow = (
  registry?: TemplateRegistry,
): WorkflowRunReceipt =>
  registry === undefined ? runDefaultWorkflow() : runWorkflowRegistry(registry);

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
  registry?: TemplateRegistry,
): McpToolCallResult => {
  if (toolName === workflowRunMcpTool.name) {
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
