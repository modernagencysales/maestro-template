import { confectManifest } from "@maestro-template/template-core/generated/confectManifest";

export type HeadlessSurface = "api" | "cli" | "mcp";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type HeadlessExecutorRequest = {
  readonly operationId: string;
  readonly surface: HeadlessSurface;
  readonly input: Record<string, JsonValue>;
  readonly idempotencyKey?: string;
};

export type HeadlessFailureResult = {
  readonly ok: false;
  readonly error: {
    readonly _tag: "NotFound" | "ValidationFailed";
    readonly message: string;
  };
};

type HeadlessManifestOperation = (typeof confectManifest.functions)[number];

export type HeadlessSuccessResult = {
  readonly ok: true;
  readonly operationId: HeadlessManifestOperation["operationId"];
  readonly result: JsonValue;
};

export type HeadlessExecutorResult =
  HeadlessSuccessResult | HeadlessFailureResult;

export type HeadlessExecutionAdapter = {
  readonly refs: Record<string, unknown>;
  readonly runQuery: (
    ref: unknown,
    input: Record<string, JsonValue>,
    operation: HeadlessManifestOperation,
  ) => unknown | Promise<unknown>;
  readonly runMutation: (
    ref: unknown,
    input: Record<string, JsonValue>,
    operation: HeadlessManifestOperation,
  ) => unknown | Promise<unknown>;
  readonly runAction: (
    ref: unknown,
    input: Record<string, JsonValue>,
    operation: HeadlessManifestOperation,
  ) => unknown | Promise<unknown>;
};

const failure = (
  tag: HeadlessFailureResult["error"]["_tag"],
  message: string,
): HeadlessFailureResult => ({
  ok: false,
  error: {
    _tag: tag,
    message,
  },
});

export const findHeadlessOperation = (
  operationId: string,
  surface: HeadlessSurface,
): HeadlessManifestOperation | undefined =>
  confectManifest.functions.find(
    (operation) =>
      operation.operationId === operationId &&
      operation.surfaces.some((candidate) => candidate === surface),
  );

export const resolveHeadlessOperation = (
  request: HeadlessExecutorRequest,
):
  | { readonly ok: true; readonly operation: HeadlessManifestOperation }
  | HeadlessFailureResult => {
  const operation = findHeadlessOperation(request.operationId, request.surface);

  if (!operation) {
    return failure(
      "NotFound",
      `No headless operation ${request.operationId} exposed on ${request.surface}.`,
    );
  }

  return { ok: true, operation };
};

const isPlainObject = (
  value: object,
): value is { readonly [key: string]: unknown } => {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const isJsonValue = (
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
): value is JsonValue => {
  if (value === null) {
    return true;
  }

  switch (typeof value) {
    case "boolean":
    case "string":
      return true;
    case "number":
      return Number.isFinite(value);
    case "object":
      break;
    default:
      return false;
  }

  if (seen.has(value)) {
    return false;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.every((item) => isJsonValue(item, seen));
  }

  return (
    isPlainObject(value) &&
    Object.values(value).every((item) => isJsonValue(item, seen))
  );
};

export const executeHeadlessOperation = async (
  adapter: HeadlessExecutionAdapter,
  request: HeadlessExecutorRequest,
): Promise<HeadlessExecutorResult> => {
  const resolved = resolveHeadlessOperation(request);
  if (!resolved.ok) {
    return resolved;
  }

  const { operation } = resolved;
  const idempotencyKey = request.idempotencyKey?.trim();
  if (!operation.idempotent && !idempotencyKey) {
    return failure(
      "ValidationFailed",
      `Operation ${operation.operationId} requires a nonblank idempotencyKey.`,
    );
  }

  const ref = adapter.refs[operation.operationId];
  if (!ref) {
    return failure(
      "NotFound",
      `No generated function ref registered for operation ${operation.operationId}.`,
    );
  }

  const input =
    idempotencyKey === undefined
      ? request.input
      : { ...request.input, idempotencyKey };

  const result = await (operation.kind === "query"
    ? adapter.runQuery(ref, input, operation)
    : operation.kind === "mutation"
      ? adapter.runMutation(ref, input, operation)
      : adapter.runAction(ref, input, operation));

  if (!isJsonValue(result)) {
    return failure(
      "ValidationFailed",
      `Operation ${operation.operationId} returned a non-JSON-safe result.`,
    );
  }

  return {
    ok: true,
    operationId: operation.operationId,
    result,
  };
};
