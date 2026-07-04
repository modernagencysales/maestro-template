import {
  buildApiCatalog,
  buildHeadlessOperations,
  buildMcpTools,
  buildOpenApiDocument,
  callMcpTool,
  describeWorkflowTemplate,
  getHeadlessOperation,
} from "@maestro-template/workflow-tooling";
import {
  providerConfigReport,
  type ProviderMode,
} from "@maestro-template/integrations";
import { parseNamedArgs } from "./namedArgs";
import { cliFailure, cliSuccess, json } from "./result";
import type {
  CliCapabilityRequest,
  CliCapabilityResolver,
  CliCommandContext,
  CliCommandHandler,
  CliResult,
  CliRuntimeConfig,
} from "./types";
import { runWorkflowReceiptForCli } from "./workflowReceipt";

type CliCommandDependencies = {
  readonly capability: CliCapabilityResolver;
};

const providerModes = new Set<ProviderMode>(["fake", "test", "live"]);

const helpResult = (): CliResult =>
  cliSuccess(
    [
      "maestro-template describe",
      "maestro-template operations list",
      "maestro-template operations get <id>",
      "maestro-template capability run <id> [--workspace <slug>] [--input <json>] [--idempotency-key <key>]",
      "maestro-template workflow run [--workflow <id>] [--workspace <slug>] [--idempotency-key <key>] [--mode <mode>] [--input <json>]",
      "maestro-template api catalog",
      "maestro-template api openapi",
      "maestro-template mcp tools",
      "maestro-template mcp call <toolName>",
      "maestro-template integrations report [fake|test|live]",
    ].join("\n") + "\n",
  );

const operationsResult = ({
  subcommand,
  target,
}: CliCommandContext): CliResult => {
  if (subcommand === "list") {
    return cliSuccess(json(buildHeadlessOperations()));
  }

  const operation = getHeadlessOperation(target ?? "");
  return operation
    ? cliSuccess(json(operation))
    : cliFailure(`Unknown operation: ${target}\n`);
};

const parseCapabilityRequest = (
  argv: readonly string[],
): CliCapabilityRequest | CliResult => {
  const parsedArgs = parseNamedArgs(argv.slice(3));
  if (!parsedArgs.ok) {
    return cliFailure(`${parsedArgs.message}\n`);
  }

  const { workspaceSlug, input, idempotencyKey } = parsedArgs.args;
  if (
    workspaceSlug === undefined ||
    input === undefined ||
    idempotencyKey === undefined
  ) {
    return cliFailure(
      "capability run requires --workspace, --input, and --idempotency-key.\n",
    );
  }

  return { workspaceSlug, input, idempotencyKey };
};

const isCliResult = (
  value: CliCapabilityRequest | CliResult,
): value is CliResult => "exitCode" in value;

const capabilityResult = (
  { argv, target }: CliCommandContext,
  capability: CliCapabilityResolver,
): CliResult => {
  const capabilityId = target ?? "";
  if (!capability.hasCapability(capabilityId)) {
    return cliFailure(`Unknown CLI capability: ${target}\n`);
  }

  const request = parseCapabilityRequest(argv);
  return isCliResult(request)
    ? request
    : capability.runCapability(capabilityId, request);
};

const apiResult = ({ subcommand }: CliCommandContext): CliResult =>
  cliSuccess(
    json(subcommand === "catalog" ? buildApiCatalog() : buildOpenApiDocument()),
  );

const mcpToolsResult = (): CliResult => cliSuccess(json(buildMcpTools()));

const mcpCallResult = ({ target }: CliCommandContext): CliResult => {
  const result = callMcpTool(target ?? "");

  return {
    exitCode: result.isError ? 1 : 0,
    stdout: json(result),
    stderr: "",
  };
};

const mcpResult = (context: CliCommandContext): CliResult =>
  context.subcommand === "tools" ? mcpToolsResult() : mcpCallResult(context);

const parseProviderMode = (mode: string): ProviderMode | undefined =>
  providerModes.has(mode as ProviderMode) ? (mode as ProviderMode) : undefined;

const integrationsResult = (
  { target }: CliCommandContext,
  config: CliRuntimeConfig,
): CliResult => {
  const mode = target ?? "fake";
  const providerMode = parseProviderMode(mode);

  return providerMode === undefined
    ? cliFailure(`Unknown provider mode: ${mode}\n`)
    : cliSuccess(json(providerConfigReport(providerMode, config.providerEnv)));
};

const workflowResult = ({ argv }: CliCommandContext): CliResult => {
  const parsedArgs = parseNamedArgs(argv.slice(2));
  if (!parsedArgs.ok) {
    return cliFailure(`${parsedArgs.message}\n`);
  }

  return cliSuccess(json(runWorkflowReceiptForCli(parsedArgs.args)));
};

export const createCliHandlers = ({
  capability,
}: CliCommandDependencies): readonly CliCommandHandler[] => [
  {
    matches: ({ command }) =>
      !command || command === "help" || command === "--help",
    run: () => helpResult(),
  },
  {
    matches: ({ command }) => command === "describe",
    run: () => cliSuccess(json(describeWorkflowTemplate())),
  },
  {
    matches: ({ command, subcommand, target }) =>
      command === "operations" &&
      (subcommand === "list" || (subcommand === "get" && target !== undefined)),
    run: (context) => operationsResult(context),
  },
  {
    matches: ({ command, subcommand }) =>
      command === "workflow" && subcommand === "run",
    run: (context) => workflowResult(context),
  },
  {
    matches: ({ command, subcommand, target }) =>
      command === "capability" && subcommand === "run" && target !== undefined,
    run: (context) => capabilityResult(context, capability),
  },
  {
    matches: ({ command, subcommand }) =>
      command === "api" &&
      (subcommand === "catalog" || subcommand === "openapi"),
    run: (context) => apiResult(context),
  },
  {
    matches: ({ command, subcommand, target }) =>
      command === "mcp" &&
      (subcommand === "tools" ||
        (subcommand === "call" && target !== undefined)),
    run: (context) => mcpResult(context),
  },
  {
    matches: ({ command, subcommand }) =>
      command === "integrations" && subcommand === "report",
    run: (context, config) => integrationsResult(context, config),
  },
];
