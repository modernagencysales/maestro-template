import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

export const currentTimeMillis = Clock.currentTimeMillis;

export const currentDate = Clock.currentTimeMillis.pipe(
  Effect.map((now) => new Date(now)),
);

export const currentIso = Clock.currentTimeMillis.pipe(
  Effect.map((now) => new Date(now).toISOString()),
);

/**
 * Drop `Clock.Clock` from an effect's requirements. Confect provides `Clock` at
 * runtime, but its current handler type omits it from the environment, so
 * clock-using effects would otherwise report an unsatisfiable requirement. This
 * is the single sanctioned bridge for that variance — keep the cast here rather
 * than re-deriving it per impl.
 */
export const unsafeAssumeClockProvided = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Exclude<R, Clock.Clock>> =>
  effect as Effect.Effect<A, E, Exclude<R, Clock.Clock>>;
