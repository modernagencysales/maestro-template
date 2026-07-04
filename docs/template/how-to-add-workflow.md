# How To Add A Workflow

Dry-run a generated workflow:

```bash
pnpm template:add-workflow -- --name sourceToBrief
```

Write the generated files:

```bash
pnpm template:add-workflow -- --name sourceToBrief --description "Turns approved sources into a reviewed brief." --write
```

Promote reviewed files into production-target workflow paths:

```bash
pnpm template:promote-workflow -- --name sourceToBrief --description "Turns approved sources into a reviewed brief." --write
```

## Files Created

Generated workflows have two halves: `convex/workflows/<name>.ts` is the durable
replay handler and `confect/workflows/<name>.{spec,impl}.ts` is the typed
start/status/approval contract. React Flow remains a projection of durable graph
data.

`template:add-workflow` writes:

- `packages/convex/confect/workflows/<name>.spec.ts`;
- `packages/convex/confect/workflows/<name>.impl.ts`;
- `packages/convex/confect/workflows/<name>.graph.ts`;
- `packages/convex/convex/workflows/<name>.ts`;
- `packages/convex/test/<name>.workflow.test.ts`;
- `docs/template/generated/workflows/<name>.md`.

Generated approval nodes are only usable through the generated
`workflows.<name>.approve` mutation, which checks workspace access before
calling `sendEvent`. Generated capability nodes are only usable when their
registry entries include a concrete `buildArgs` mapper for the target internal
capability ref.

Use `template:promote-workflow` only for older review artifacts or private
package promotion flows that still need promotion into production-target paths.

## Tests

- graph validation;
- kickoff auth;
- policy snapshot;
- capability-step composition;
- durable replay;
- retry and idempotency;
- schedule and missed-run policy;
- run-observability ledger.

## Gates

- `pnpm --dir packages/convex test workflows`
- `pnpm --dir apps/web test src/features/workflows`
- `pnpm check:workflow-graph-boundary`
- `pnpm check:confect-contracts`
