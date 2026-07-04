import * as Effect from "effect/Effect";
import * as Either from "effect/Either";
import {
  normalizeMutationSuccess,
  type TemplateMutationState,
  type TemplateReadyMode,
} from "./confect-state";

export type FrontendEffectBoundaryResult<Value, TypedError> =
  TemplateMutationState<Value, TypedError>;

const abortedState = (): TemplateMutationState<never, never> => ({
  status: "transport_failure",
  error: new Error("Action aborted."),
  message: "Action aborted.",
});

const abortStateFor = (
  signal: AbortSignal | undefined,
): TemplateMutationState<never, never> | undefined =>
  signal?.aborted === true ? abortedState() : undefined;

const normalizeEffectResult = <Value, TypedError>(
  result: Either.Either<Value, TypedError>,
  mode: TemplateReadyMode | undefined,
): FrontendEffectBoundaryResult<Value, TypedError> =>
  Either.isLeft(result)
    ? { status: "typed_failure", error: result.left }
    : normalizeMutationSuccess(
        result.right,
        mode === undefined ? {} : { mode },
      );

const defectState = <TypedError>(
  error: unknown,
): TemplateMutationState<never, TypedError> => ({
  status: "defect",
  error,
  message: error instanceof Error ? error.message : String(error),
});

export const runFrontendEffectBoundary = async <Value, TypedError>(
  effect: Effect.Effect<Value, TypedError, never>,
  options: {
    readonly signal?: AbortSignal;
    readonly mode?: TemplateReadyMode;
  } = {},
): Promise<FrontendEffectBoundaryResult<Value, TypedError>> => {
  let boundaryState:
    FrontendEffectBoundaryResult<Value, TypedError> | undefined = abortStateFor(
    options.signal,
  );

  if (boundaryState === undefined) {
    try {
      const result = await Effect.runPromise(Effect.either(effect), {
        signal: options.signal,
      });
      boundaryState =
        abortStateFor(options.signal) ??
        normalizeEffectResult(result, options.mode);
    } catch (error) {
      boundaryState = abortStateFor(options.signal) ?? defectState(error);
    }
  }

  return boundaryState;
};
