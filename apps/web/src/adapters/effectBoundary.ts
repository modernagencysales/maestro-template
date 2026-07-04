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

export const runFrontendEffectBoundary = async <Value, TypedError>(
  effect: Effect.Effect<Value, TypedError, never>,
  options: {
    readonly signal?: AbortSignal;
    readonly mode?: TemplateReadyMode;
  } = {},
): Promise<FrontendEffectBoundaryResult<Value, TypedError>> => {
  if (options.signal?.aborted) return abortedState();

  try {
    const result = await Effect.runPromise(Effect.either(effect), {
      signal: options.signal,
    });
    if (options.signal?.aborted) return abortedState();
    if (Either.isLeft(result)) {
      return { status: "typed_failure", error: result.left };
    }
    return normalizeMutationSuccess(
      result.right,
      options.mode === undefined ? {} : { mode: options.mode },
    );
  } catch (error) {
    if (options.signal?.aborted) return abortedState();
    return {
      status: "defect",
      error,
      message: error instanceof Error ? error.message : String(error),
    };
  }
};
