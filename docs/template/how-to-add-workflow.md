# How To Add A Workflow

Dry-run a generated workflow:

```bash
pnpm template:add-workflow -- --name sourceToBrief
```

Write the generated files:

```bash
pnpm template:add-workflow -- --name sourceToBrief --description "Turns approved sources into a reviewed brief." --write
```

`template:add-workflow` writes the production-target workflow contract, durable
graph, runner, test scaffold, and generated docs directly. Do not run
`template:promote-workflow` as the normal next step for files created by
`template:add-workflow`.

Regenerate Convex refs after the files are written and before typechecking the
durable runner:

```bash
pnpm --dir packages/convex exec convex codegen
```

Run `pnpm confect:codegen` when you need the generated
`workflowContracts.<name>` public wrappers. The current Confect sync owns
generated Convex modules, so if you run it after `template:add-workflow`, rerun
the workflow generator or restore
`packages/convex/convex/workflowRunners/<name>.ts` before Convex codegen and
package typecheck.

## Files Created

Generated workflows have two halves:
`packages/convex/convex/workflowRunners/<name>.ts` is the plain Convex
`defineWorkflow` durable replay handler, and
`packages/convex/confect/workflowContracts/<name>.{spec,impl}.ts` is the typed
start/status/approval contract. React Flow remains a projection of durable graph
data.

`template:add-workflow` writes:

- `packages/convex/confect/workflowContracts/<name>.spec.ts`;
- `packages/convex/confect/workflowContracts/<name>.impl.ts`;
- `packages/convex/confect/workflows/<name>.graph.ts`;
- `packages/convex/convex/workflowRunners/<name>.ts`;
- `packages/convex/test/<name>.workflow.test.ts`;
- `docs/template/generated/workflows/<name>.md`.

Generated approval nodes are only usable through the generated
`workflowContracts.<name>.approve` mutation, which checks workspace access
before calling `sendEvent`. Generated capability nodes are only usable when
their registry entries include a concrete `buildArgs` mapper for the target
internal capability ref.

Use `template:promote-workflow` only for older review artifacts or private
package promotion flows that still need promotion into production-target paths.
For new generated workflows, `template:add-workflow -- --write` already writes
those production-target paths.

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

- `pnpm --dir packages/convex exec convex codegen`
- `pnpm --dir packages/convex typecheck`
- `pnpm template:workflow-output-smoke`
- `pnpm confect:codegen` when validating generated public workflow contract refs
- `pnpm --dir packages/convex test workflows`
- `pnpm --dir apps/web test src/features/workflows`
- `pnpm check:workflow-graph-boundary`
- `pnpm check:confect-contracts`
