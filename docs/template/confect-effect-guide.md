# Confect And Effect Guide

The template uses Confect to integrate Effect schemas and services with Convex.
The goal is end-to-end typed contracts without losing Convex component support.

## Version Policy

- Pin all `@confect/*` packages to one released version.
- Pin `effect` and companion `@effect/*` packages to a tested compatible set.
- Do not install fallback placeholder versions. Resolve package metadata first,
  then record the exact compatibility pair in this guide.
- Do not adopt Effect v4 or beta lines until Confect compatibility is verified
  in CI.
- Record version changes in this guide and in the lockfile diff.

## Compatibility Matrix

| Surface        | Package(s)                                                                                 | Version                                           | Evidence                                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Confect server | `@confect/core`, `@confect/server`, `@confect/cli`, `@confect/test`                        | `9.1.5`                                           | Package metadata: peers require Effect `^3.21.2`, Convex `^1.32.0`, `@effect/platform` `^0.96.1`, and `@effect/platform-node` `^0.106.0`. |
| Confect client | `@confect/react`, `@confect/js`                                                            | `9.1.5`                                           | Package metadata: peers require Effect `^3.21.2`, Convex `^1.32.0`, and React `^18` or `^19` for React hooks.                             |
| Effect runtime | `effect`, `@effect/platform`, `@effect/platform-node`, `@effect/cluster`, `@effect/vitest` | `3.21.4`, `0.96.2`, `0.106.0`, `0.58.0`, `0.29.0` | `@effect/platform-node@0.106.0` matches Confect's `^0.106.0` peer; `0.107.0` is intentionally not used.                                   |
| Convex         | `convex`, `convex-test`                                                                    | `1.42.1`, `0.0.54`                                | Satisfies Confect peers and `@confect/test`'s `convex-test >=0.0.50 <0.1.0` peer.                                                         |

## File Model

- Tables: `packages/convex/confect/tables/*`
- Specs: `packages/convex/confect/**/<group>.spec.ts`
- Impls: `packages/convex/confect/**/<group>.impl.ts`
- Plain Convex interop: colocated `.ts`, `.spec.ts`, and `.impl.ts`
- Special entrypoints: `confect/auth.ts`, `confect/crons.ts`, `confect/http.ts`

`packages/convex/confect/http.ts` owns the current API surface. It serves the
generated OpenAPI document at `/api/openapi.json`, the Scalar shell at
`/api/docs`, and reviewer-safe executable `POST /api/<operation>` handlers from
the same headless registry metadata. Production client apps should replace the
deterministic template operation runner with generated Confect runner services
without duplicating headless registry metadata.

## Convex Component Interop

- Plain Convex functions required by Convex components must live beside their
  Confect spec and impl files.
- Specs must import plain Convex functions with `import type`; impls pass the
  real function values to `FunctionImpl.make`.
- Local template typechecks may use narrow component-reference shims when Convex
  deployment codegen has not been provisioned yet. Provisioned apps must run
  `convex dev` or `convex codegen` and prefer generated `components` refs.
- `check:confect-contracts` must fail if a spec runtime-imports plain Convex
  functions or if generated Confect wrappers are stale.

## Function Rules

- Args, returns, and expected errors use Effect schemas.
- No useful return means `Schema.Null`.
- Expected failures use tagged errors and the Effect error channel.
- Unexpected defects may die; they must not serialize private data.
- Public-safe errors are separate from internal provider/config errors. Provider
  payloads, secret names, secret values, and stack traces are redacted before
  crossing public Confect boundaries.
- Queries are read-only and deterministic. Mutations perform transactional
  writes. Actions and scheduled functions own external provider side effects.
- Specs use type-only imports for plain Convex function values with
  `import type`.
- Impls end with `GroupImpl.finalize`.
- Confect schemas must have Convex-serializable encoded values and no schema
  context. Cover Dates, branded ids, unions, nullable fields, transforms, and
  arrays with compile-time and runtime schema tests.

## Client Rules

- Web uses `@confect/react` generated refs.
- CLI and MCP use `@confect/js` generated refs.
- HTTP APIs call generated runner services rather than duplicating business
  logic.
- React adapters distinguish loading, empty, ready, skipped, typed failure,
  parse failure, transport failure, and defects.
- Feature surfaces use shared Confect React adapters rather than hand-rolled raw
  hook handling.
- Type assertions prove refs infer args, returns, typed failures, `QueryResult`,
  `Either`, and JS-client error channels.

## Testing

Use `@confect/test` for generated refs, auth identity, typed errors, HTTP
routes, scheduled functions, storage, Node actions, and plain Convex interop in
provisioned apps with Convex `_generated` codegen. The private template also
keeps lightweight contract tests under `packages/convex/test` for generated ref
metadata, Effect schema validation, public-safe typed errors, HTTP routes, and
plain Convex registration shape without requiring a live Convex deployment.

Run `check:confect-compat` after every Confect contract change. It must cover
codegen, generated-file diffs, `@confect/test`, HTTP/Scalar fetch, React type
fixtures, and JavaScript client type fixtures.

## Generated Contract Manifest

This migration plan introduces the target model where the generated Confect spec
tree becomes the source of truth for API, CLI, MCP, OpenAPI, Scalar, workflow,
and web-facing operation metadata. Today, the runtime headless projection still
derives from the canned `templateRegistry` until later effectification tasks
replace it with generated contract metadata.

Target rules:

- Every public headless operation declares a typed public error schema.
- Every headless operation declares allowed surfaces explicitly.
- Surface exposure defaults to an empty set.
- Writes exposed over API, CLI, or MCP require an idempotency key argument.
- Tenant identity is server-derived through a Principal and workspace access
  resolver, never trusted from caller-supplied workspace slug alone.
- OpenAPI schemas are generated from Effect schemas with `effect/JSONSchema`
  after Confect schema restrictions are satisfied.
- Public error envelopes encode only the declared public `_tag` and redacted
  fields.

## Confect V9 Baseline

This template treats Confect v9 as the required authoring model, not as an
optional upgrade. The v9 release rearchitected generated Convex modules so a
function imports only its own group registry at cold start instead of a
project-wide aggregate. The template must preserve that benefit as it grows.

Required invariants:

- All `@confect/*` packages remain on the same v9-compatible release line.
- API groups are filesystem-driven colocated `*.spec.ts` and `*.impl.ts` pairs.
- `GroupSpec.make()` and `GroupSpec.makeNode()` do not take a group-name
  argument; the file path names the group.
- Every table under `packages/convex/confect/tables/*` default-exports
  `Table.make(() => <Confect-compatible Effect schema>)`; the filename is the
  table name. The schema may be an imported constant as long as it is built
  lazily inside the callback.
- Specs import generated table wrappers from `confect/_generated/tables/*` for
  `Doc`, `Fields`, and `tableName`.
- Specs wrap `args`, `returns`, and `error` schemas in `() =>` thunks.
- Impls import `databaseSchema` from `confect/_generated/schema`, pass it to
  `FunctionImpl.make` and `GroupImpl.make`, default-import the sibling spec, and
  end with `GroupImpl.finalize`.
- Root aggregate `confect/spec.ts`, `confect/impl.ts`, `confect/nodeSpec.ts`,
  and `confect/nodeImpl.ts` must not exist.
- Confect source imports Effect submodules such as `effect/Effect`,
  `effect/Schema`, `effect/Layer`, `effect/Clock`, and `effect/Either`; it does
  not import from the `effect` barrel inside `packages/convex/confect`.
- `@confect/test` uses generated `confect/_generated/schema` and generated
  `confect/_generated/convexSchema`.

The compatibility gate `pnpm check:confect-v9` currently enforces the
mechanically checkable subset: exact v9 `@confect/*` package alignment, no root
aggregate Confect entrypoints, no `effect` barrel imports under
`packages/convex/confect`, lazy `args`/`returns`/`error` schema thunks in
`FunctionSpec` object literals, generated `databaseSchema` usage plus
`GroupImpl.finalize` in impls, and lazy table default exports without table-name
arguments.

## Effectified-Full Primitives

Reusable primitives follow `docs/template/primitive-contract.md`. A primitive is
not considered template-ready when it only has a Confect function. It also needs
the pure domain boundary, typed errors, service boundaries, manifest metadata,
workflow-step eligibility when dispatchable, frontend state when visible, tests,
gates, and docs.
