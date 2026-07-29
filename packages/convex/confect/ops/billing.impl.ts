import { FunctionImpl, GroupImpl } from "@confect/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import databaseSchema from "../_generated/schema";
import { DatabaseReader, DatabaseWriter } from "../_generated/services";
import { requireWorkspaceAccess } from "../capabilities/_kit/workspaceAccess";
import { unsafeAssumeClockProvided } from "../shared/clock";
import { validateCallerIdempotencyKey } from "../shared/idempotencyKey";
import billing, { BillingError } from "./billing.spec";

const fixedTimestampMs = 1_700_000_000_000;

const recordUsage = FunctionImpl.make(
  databaseSchema,
  billing,
  "recordUsage",
  (input) =>
    Effect.gen(function* () {
      const idempotencyKey = validateCallerIdempotencyKey(input.idempotencyKey);

      if (!idempotencyKey.ok) {
        return yield* Effect.fail(
          new BillingError.ValidationFailed({
            field: "idempotencyKey",
            message: idempotencyKey.error.message,
          }),
        );
      }

      yield* unsafeAssumeClockProvided(
        requireWorkspaceAccess(input.workspaceId, "viewer"),
      );

      const reader = yield* DatabaseReader;
      const writer = yield* DatabaseWriter;
      const existingUsage = yield* atMostOneOrDie(
        "billing usage idempotency key",
        yield* reader
          .table("usageEvents")
          .index("by_workspace_idempotency", (q) =>
            q
              .eq("workspaceId", input.workspaceId)
              .eq("idempotencyKey", idempotencyKey.value),
          )
          .take(2)
          .pipe(Effect.orDie),
      );

      if (existingUsage !== null) {
        const payloadMismatch = usagePayloadMismatch(existingUsage, input);

        if (payloadMismatch !== null) {
          return yield* Effect.fail(
            new BillingError.ValidationFailed({
              field: payloadMismatch,
              message:
                "idempotencyKey was already used for a different billing usage payload.",
            }),
          );
        }

        const existingLedger = yield* atMostOneOrDie(
          "billing ledger idempotency key",
          yield* reader
            .table("creditLedger")
            .index("by_workspace_idempotency", (q) =>
              q
                .eq("workspaceId", input.workspaceId)
                .eq("idempotencyKey", idempotencyKey.value),
            )
            .take(2)
            .pipe(Effect.orDie),
        );

        if (existingLedger === null) {
          return yield* Effect.die(
            new Error("Billing usage event is missing its ledger entry."),
          );
        }

        return usageReturn(existingUsage, existingLedger._id);
      }

      const entitlement = yield* atMostOneOrDie(
        "billing entitlement key",
        yield* reader
          .table("entitlements")
          .index("by_workspace_entitlement", (q) =>
            q
              .eq("workspaceId", input.workspaceId)
              .eq("entitlementKey", input.entitlementKey),
          )
          .take(2)
          .pipe(Effect.orDie),
      );

      if (entitlement === null || entitlement.status !== "active") {
        return yield* Effect.fail(
          new BillingError.InsufficientCredits({
            availableCredits: 0,
            requestedCredits: input.costCredits,
          }),
        );
      }

      const availableCredits = entitlement.limit - entitlement.used;
      if (input.costCredits > availableCredits) {
        return yield* Effect.fail(
          new BillingError.InsufficientCredits({
            availableCredits,
            requestedCredits: input.costCredits,
          }),
        );
      }

      const usageEventId = yield* writer
        .table("usageEvents")
        .insert({
          workspaceId: input.workspaceId,
          idempotencyKey: idempotencyKey.value,
          provider: input.provider,
          units: input.units,
          costCredits: input.costCredits,
          entitlementKey: input.entitlementKey,
          createdAt: fixedTimestampMs,
        })
        .pipe(Effect.orDie);
      const ledgerEntryId = yield* writer
        .table("creditLedger")
        .insert({
          workspaceId: input.workspaceId,
          type: "debit" as const,
          credits: input.costCredits,
          reason: "llm_usage" as const,
          idempotencyKey: idempotencyKey.value,
          appendOnly: true as const,
          createdAt: fixedTimestampMs,
          createdBy: "system:billing",
        })
        .pipe(Effect.orDie);

      yield* writer
        .table("entitlements")
        .patch(entitlement._id, {
          used: entitlement.used + input.costCredits,
          updatedAt: fixedTimestampMs,
        })
        .pipe(Effect.orDie);

      return {
        workspaceId: input.workspaceId,
        usageEventId,
        ledgerEntryId,
        idempotencyKey: idempotencyKey.value,
        provider: input.provider,
        units: input.units,
        costCredits: input.costCredits,
        entitlementKey: input.entitlementKey,
        appendOnly: true as const,
        createdAt: fixedTimestampMs,
      };
    }),
);

const atMostOneOrDie = <A>(
  description: string,
  rows: readonly A[],
): Effect.Effect<A | null, never> => {
  if (rows.length > 1) {
    return Effect.die(new Error(`Duplicate ${description} rows found.`));
  }

  return Effect.succeed(rows[0] ?? null);
};

const usagePayloadMismatch = (
  existingUsage: {
    readonly provider: "openrouter" | "dodo" | "mailersend" | "storage";
    readonly units: number;
    readonly costCredits: number;
    readonly entitlementKey: string;
  },
  input: {
    readonly provider: "openrouter" | "dodo" | "mailersend" | "storage";
    readonly units: number;
    readonly costCredits: number;
    readonly entitlementKey: string;
  },
): "provider" | "units" | "costCredits" | "entitlementKey" | null => {
  if (existingUsage.provider !== input.provider) return "provider";
  if (existingUsage.units !== input.units) return "units";
  if (existingUsage.costCredits !== input.costCredits) return "costCredits";
  if (existingUsage.entitlementKey !== input.entitlementKey) {
    return "entitlementKey";
  }

  return null;
};

const usageReturn = (
  usage: {
    readonly _id: string;
    readonly workspaceId: string;
    readonly idempotencyKey: string;
    readonly provider: "openrouter" | "dodo" | "mailersend" | "storage";
    readonly units: number;
    readonly costCredits: number;
    readonly entitlementKey: string;
    readonly createdAt: number;
  },
  ledgerEntryId: string,
) => ({
  workspaceId: usage.workspaceId,
  usageEventId: usage._id,
  ledgerEntryId,
  idempotencyKey: usage.idempotencyKey,
  provider: usage.provider,
  units: usage.units,
  costCredits: usage.costCredits,
  entitlementKey: usage.entitlementKey,
  appendOnly: true as const,
  createdAt: usage.createdAt,
});

const applyWebhook = FunctionImpl.make(
  databaseSchema,
  billing,
  "applyWebhook",
  (input) =>
    Effect.gen(function* () {
      const dedupeKey = validateCallerIdempotencyKey(input.dedupeKey);

      if (!dedupeKey.ok) {
        return yield* Effect.fail(
          new BillingError.ValidationFailed({
            field: "dedupeKey",
            message: dedupeKey.error.message.replace(
              "idempotencyKey",
              "dedupeKey",
            ),
          }),
        );
      }

      const reader = yield* DatabaseReader;
      const writer = yield* DatabaseWriter;
      const existingWebhook = yield* atMostOneOrDie(
        "billing webhook dedupe key",
        yield* reader
          .table("webhookEvents")
          .index("by_dedupe_key", (q) => q.eq("dedupeKey", dedupeKey.value))
          .take(2)
          .pipe(Effect.orDie),
      );

      if (existingWebhook !== null) {
        const payloadMismatch = webhookPayloadMismatch(existingWebhook, {
          ...input,
          dedupeKey: dedupeKey.value,
        });

        if (payloadMismatch !== null) {
          return yield* Effect.fail(
            new BillingError.ValidationFailed({
              field: payloadMismatch,
              message:
                "dedupeKey was already used for a different billing webhook payload.",
            }),
          );
        }

        return webhookReturn(existingWebhook, "duplicate");
      }

      yield* writer
        .table("webhookEvents")
        .insert({
          workspaceId: input.workspaceId,
          provider: input.provider,
          eventId: input.eventId,
          eventType: input.eventType,
          signatureTimestamp: input.signatureTimestamp,
          dedupeKey: dedupeKey.value,
          status: "processed" as const,
          createdAt: fixedTimestampMs,
        })
        .pipe(Effect.orDie);

      return {
        workspaceId: input.workspaceId,
        provider: input.provider,
        eventId: input.eventId,
        eventType: input.eventType,
        signatureTimestamp: input.signatureTimestamp,
        dedupeKey: dedupeKey.value,
        status: "processed" as const,
        createdAt: fixedTimestampMs,
      };
    }),
);

const webhookPayloadMismatch = (
  existingWebhook: {
    readonly workspaceId: string;
    readonly provider: "dodo";
    readonly eventId: string;
    readonly eventType: string;
    readonly signatureTimestamp: string;
    readonly dedupeKey: string;
  },
  input: {
    readonly workspaceId: string;
    readonly provider: "dodo";
    readonly eventId: string;
    readonly eventType: string;
    readonly signatureTimestamp: string;
    readonly dedupeKey: string;
  },
):
  | "workspaceId"
  | "provider"
  | "eventId"
  | "eventType"
  | "signatureTimestamp"
  | "dedupeKey"
  | null => {
  if (existingWebhook.workspaceId !== input.workspaceId) return "workspaceId";
  if (existingWebhook.provider !== input.provider) return "provider";
  if (existingWebhook.eventId !== input.eventId) return "eventId";
  if (existingWebhook.eventType !== input.eventType) return "eventType";
  if (existingWebhook.signatureTimestamp !== input.signatureTimestamp) {
    return "signatureTimestamp";
  }
  if (existingWebhook.dedupeKey !== input.dedupeKey) return "dedupeKey";

  return null;
};

const webhookReturn = (
  webhook: {
    readonly workspaceId: string;
    readonly provider: "dodo";
    readonly eventId: string;
    readonly eventType: string;
    readonly signatureTimestamp: string;
    readonly dedupeKey: string;
    readonly createdAt: number;
  },
  status: "processed" | "duplicate" | "failed",
) => ({
  workspaceId: webhook.workspaceId,
  provider: webhook.provider,
  eventId: webhook.eventId,
  eventType: webhook.eventType,
  signatureTimestamp: webhook.signatureTimestamp,
  dedupeKey: webhook.dedupeKey,
  status,
  createdAt: webhook.createdAt,
});

// This is the deterministic fake/local implementation of the public contract.
// Forks replace it with an authorized, idempotent persistence boundary.
const grantEntitlementFixture = FunctionImpl.make(
  databaseSchema,
  billing,
  "grantEntitlement",
  (input) =>
    Effect.succeed({
      workspaceId: input.workspaceId,
      entitlementKey: input.entitlementKey,
      featureKey: input.featureKey,
      limit: input.limit,
      used: 0,
      source: input.source,
      status: "active" as const,
      createdAt: fixedTimestampMs,
    }),
);

const checkSeat = FunctionImpl.make(
  databaseSchema,
  billing,
  "checkSeat",
  (input) =>
    Effect.succeed({
      workspaceId: input.workspaceId,
      allowed: input.requestedSeats <= input.seatLimit,
      currentSeats: input.currentSeats,
      requestedSeats: input.requestedSeats,
      seatLimit: input.seatLimit,
    }),
);

export default GroupImpl.make(databaseSchema, billing).pipe(
  Layer.provide(recordUsage),
  Layer.provide(applyWebhook),
  Layer.provide(grantEntitlementFixture),
  Layer.provide(checkSeat),
  GroupImpl.finalize,
);
