import * as S from "effect/Schema";

import {
  evaluateSafeConditionExpression,
  isSafeConditionExpression,
  type WorkflowConditionContext,
} from "./conditionExpression";
import { validateWorkflowGraph } from "./graphValidation";

export const WorkflowNodeKind = S.Literal(
  "source",
  "capability",
  "agent",
  "delay",
  "approval",
  "output",
);

export type WorkflowNodeKind = S.Schema.Type<typeof WorkflowNodeKind>;

export const WorkflowRetryConfig = S.Struct({
  maxAttempts: S.Number,
  backoffMs: S.Number,
});

export const WorkflowCondition = S.Struct({
  expression: S.String,
});

export const WorkflowNode = S.Struct({
  id: S.String,
  kind: WorkflowNodeKind,
  label: S.String,
  capability: S.optional(S.String),
  agent: S.optional(S.String),
  delayMs: S.optional(S.Number),
  retry: WorkflowRetryConfig,
});

export const WorkflowEdge = S.Struct({
  id: S.String,
  sourceNodeId: S.String,
  targetNodeId: S.String,
  condition: S.optional(WorkflowCondition),
});

export const WorkflowJoin = S.Struct({
  nodeId: S.String,
  strategy: S.Literal("all-successful", "any-successful"),
  sourceNodeIds: S.Array(S.String),
});

export const DurableWorkflowGraph = S.Struct({
  id: S.String,
  version: S.Number,
  startNodeId: S.String,
  nodes: S.Array(WorkflowNode).pipe(S.minItems(1)),
  edges: S.Array(WorkflowEdge),
  joins: S.Array(WorkflowJoin),
});

export type DurableWorkflowGraph = S.Schema.Type<typeof DurableWorkflowGraph>;

export type WorkflowNode = S.Schema.Type<typeof WorkflowNode>;
export type WorkflowEdge = S.Schema.Type<typeof WorkflowEdge>;
export type WorkflowJoin = S.Schema.Type<typeof WorkflowJoin>;

export namespace WorkflowGraphValidationError {
  export class MissingStartNode extends S.TaggedError<MissingStartNode>()(
    "MissingStartNode",
    {
      startNodeId: S.String,
    },
  ) {}

  export class DuplicateNodeId extends S.TaggedError<DuplicateNodeId>()(
    "DuplicateNodeId",
    {
      nodeId: S.String,
    },
  ) {}

  export class DuplicateEdgeId extends S.TaggedError<DuplicateEdgeId>()(
    "DuplicateEdgeId",
    {
      edgeId: S.String,
    },
  ) {}

  export class DanglingEdge extends S.TaggedError<DanglingEdge>()(
    "DanglingEdge",
    {
      edgeId: S.String,
      nodeId: S.String,
    },
  ) {}

  export class InvalidRetryConfig extends S.TaggedError<InvalidRetryConfig>()(
    "InvalidRetryConfig",
    {
      nodeId: S.String,
      field: S.Literal("maxAttempts", "backoffMs"),
    },
  ) {}

  export class InvalidDelayConfig extends S.TaggedError<InvalidDelayConfig>()(
    "InvalidDelayConfig",
    {
      nodeId: S.String,
      field: S.Literal("delayMs"),
    },
  ) {}

  export class InvalidJoin extends S.TaggedError<InvalidJoin>()("InvalidJoin", {
    nodeId: S.String,
    reason: S.String,
  }) {}

  export class InvalidConditionExpression extends S.TaggedError<InvalidConditionExpression>()(
    "InvalidConditionExpression",
    {
      edgeId: S.String,
    },
  ) {}

  export const Schema = S.Union(
    MissingStartNode,
    DuplicateNodeId,
    DuplicateEdgeId,
    DanglingEdge,
    InvalidRetryConfig,
    InvalidDelayConfig,
    InvalidJoin,
    InvalidConditionExpression,
  );
}

export type WorkflowGraphValidationError = S.Schema.Type<
  typeof WorkflowGraphValidationError.Schema
>;

export {
  evaluateSafeConditionExpression,
  isSafeConditionExpression,
  validateWorkflowGraph,
  type WorkflowConditionContext,
};
