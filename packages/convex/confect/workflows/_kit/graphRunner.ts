import type { FunctionReference } from "convex/server";

import { makePublicError } from "../../shared/errors";
import { runObservedWorkflowStage } from "./observedStage";
import {
  evaluateSafeConditionExpression,
  validateWorkflowGraph,
  type DurableWorkflowGraph,
  type WorkflowEdge,
  type WorkflowJoin,
  type WorkflowNode,
} from "../graph";

export type DurableGraphStepKind = "query" | "mutation" | "action";

export type DurableGraphStepRef<
  Kind extends DurableGraphStepKind = DurableGraphStepKind,
> = FunctionReference<Kind, "internal">;

export type DurableGraphCapabilityEnvelope = {
  readonly inputs: unknown;
  readonly context: Readonly<Record<string, unknown>>;
  readonly node: WorkflowNode;
  readonly policySnapshot: unknown;
};

export type DurableGraphCapabilityEntry<
  Kind extends DurableGraphStepKind = DurableGraphStepKind,
> = {
  readonly kind: Kind;
  readonly ref: DurableGraphStepRef<Kind>;
  readonly agentSeat?: true;
  readonly buildArgs?: (
    envelope: DurableGraphCapabilityEnvelope,
  ) => Record<string, unknown>;
};

export type RunDurableGraphInput = {
  readonly graph: DurableWorkflowGraph;
  readonly inputs: unknown;
  readonly policySnapshot: unknown;
  readonly capabilityRegistry: Readonly<
    Record<string, DurableGraphCapabilityEntry>
  >;
  readonly projectOutput?: (
    envelope: DurableGraphCapabilityEnvelope,
  ) => Record<string, unknown>;
  readonly observability?: {
    readonly workflowRunId?: string;
    readonly componentWorkflowId?: string;
    readonly recordStageStarted?: DurableGraphStepRef<"mutation">;
    readonly recordStageFinished?: DurableGraphStepRef<"mutation">;
  };
};

export type RunDurableGraphStep = {
  readonly runQuery: (
    ref: DurableGraphStepRef<"query">,
    args: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => Promise<unknown>;
  readonly runMutation: (
    ref: DurableGraphStepRef<"mutation">,
    args: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => Promise<unknown>;
  readonly runAction: (
    ref: DurableGraphStepRef<"action">,
    args: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => Promise<unknown>;
  readonly sleep: (
    delayMs: number,
    options?: { readonly name?: string },
  ) => Promise<void>;
  readonly awaitEvent: <Result = unknown>(event: {
    readonly name: string;
  }) => Promise<Result>;
};

export const runDurableGraphWorkflow = async (
  step: RunDurableGraphStep,
  input: RunDurableGraphInput,
): Promise<Readonly<Record<string, unknown>>> => {
  const validationErrors = validateWorkflowGraph(input.graph);
  if (validationErrors.length > 0) {
    throw makePublicError("VALIDATION_FAILED", "Workflow graph is invalid.", {
      errorCount: validationErrors.length,
    });
  }

  const nodesById = new Map(input.graph.nodes.map((node) => [node.id, node]));
  const startNode = nodesById.get(input.graph.startNodeId);
  if (!startNode) {
    throw makePublicError("VALIDATION_FAILED", "Workflow graph is invalid.");
  }

  preflightCapabilityRegistry(input.graph, input.capabilityRegistry);

  const incomingByNode = groupEdgesByTarget(input.graph.edges);
  const outgoingByNode = groupEdgesBySource(input.graph.edges);
  const joinsByNode = new Map(
    input.graph.joins.map((join) => [join.nodeId, join]),
  );
  const context: Record<string, unknown> = {};
  const completedNodes = new Set<string>();
  const passedEdges = new Set<string>();
  const failedEdges = new Set<string>();
  const queuedNodes = new Set<string>([startNode.id]);
  const queue: string[] = [startNode.id];
  let order = 0;

  while (queue.length > 0) {
    const nodeId = queue.shift();
    if (!nodeId || completedNodes.has(nodeId)) {
      continue;
    }
    queuedNodes.delete(nodeId);
    const node = nodesById.get(nodeId);
    if (!node) {
      continue;
    }

    const result = await runObservedWorkflowStage({
      step,
      ...(input.observability
        ? {
            refs: input.observability,
            ...(input.observability.workflowRunId
              ? { workflowRunId: input.observability.workflowRunId }
              : {}),
            ...(input.observability.componentWorkflowId
              ? { componentWorkflowId: input.observability.componentWorkflowId }
              : {}),
          }
        : {}),
      nodeId: node.id,
      label: node.label,
      kind: node.kind,
      stageKey: node.id,
      attemptNumber: 1,
      order,
      run: () => executeNode(step, input, node, context),
    });
    order += 1;

    assertJsonSafe(
      result,
      `Workflow node ${node.id} returned non-JSON output.`,
    );
    context[node.id] = result;
    completedNodes.add(node.id);

    if (node.kind === "output") {
      assertJsonObject(result, "Workflow output must be a JSON object.");
      return result as Readonly<Record<string, unknown>>;
    }

    for (const edge of outgoingByNode.get(node.id) ?? []) {
      const isActive = isEdgeActive(edge, input, context);
      if (isActive) {
        passedEdges.add(edge.id);
      } else {
        failedEdges.add(edge.id);
      }

      const target = nodesById.get(edge.targetNodeId);
      if (
        target &&
        isActive &&
        !completedNodes.has(target.id) &&
        !queuedNodes.has(target.id) &&
        isNodeReady(
          target,
          incomingByNode,
          joinsByNode,
          passedEdges,
          failedEdges,
        )
      ) {
        queuedNodes.add(target.id);
        queue.push(target.id);
      }
    }
  }

  assertJsonSafe(context, "Workflow context must be JSON-safe.");
  return context;
};

const executeNode = async (
  step: RunDurableGraphStep,
  input: RunDurableGraphInput,
  node: WorkflowNode,
  context: Readonly<Record<string, unknown>>,
): Promise<unknown> => {
  switch (node.kind) {
    case "source":
      return input.inputs;
    case "capability":
      return dispatchCapability(step, input, node, context, false);
    case "agent":
      return dispatchCapability(step, input, node, context, true);
    case "delay": {
      const delayMs = node.delayMs ?? 0;
      await step.sleep(delayMs, { name: `${input.graph.id}.${node.id}.delay` });
      return { delayedMs: delayMs };
    }
    case "approval":
      return step.awaitEvent({
        name: `${input.graph.id}.${node.id}.approved`,
      });
    case "output": {
      const envelope = buildEnvelope(input, node, context);
      const projected =
        input.projectOutput?.(envelope) ??
        ({
          inputs: input.inputs,
          context,
          policySnapshot: input.policySnapshot,
        } satisfies Record<string, unknown>);
      assertJsonObject(projected, "Workflow output must be a JSON object.");
      return projected;
    }
    default:
      throw makePublicError(
        "VALIDATION_FAILED",
        `Unsupported workflow node kind: ${(node as { kind?: string }).kind}`,
      );
  }
};

const dispatchCapability = async (
  step: RunDurableGraphStep,
  input: RunDurableGraphInput,
  node: WorkflowNode,
  context: Readonly<Record<string, unknown>>,
  agentOnly: boolean,
): Promise<unknown> => {
  const capabilityKey = agentOnly
    ? (node.agent ?? node.capability)
    : node.capability;
  if (!capabilityKey) {
    throw makePublicError(
      "VALIDATION_FAILED",
      `${agentOnly ? "Agent" : "Capability"} node is missing a capability ref.`,
      { nodeId: node.id },
    );
  }

  const entry = input.capabilityRegistry[capabilityKey];
  if (!entry) {
    throw makePublicError(
      "VALIDATION_FAILED",
      `Missing workflow capability ref: ${capabilityKey}`,
      { nodeId: node.id },
    );
  }

  if (agentOnly && entry.agentSeat !== true) {
    throw makePublicError(
      "VALIDATION_FAILED",
      `Agent node is not tagged as an agent seat: ${capabilityKey}`,
      { nodeId: node.id },
    );
  }

  const envelope = buildEnvelope(input, node, context);
  const args = entry.buildArgs?.(envelope) ?? envelope;

  switch (entry.kind) {
    case "action":
      return step.runAction(entry.ref as DurableGraphStepRef<"action">, args);
    case "mutation":
      return step.runMutation(
        entry.ref as DurableGraphStepRef<"mutation">,
        args,
      );
    case "query":
      return step.runQuery(entry.ref as DurableGraphStepRef<"query">, args);
  }
};

const buildEnvelope = (
  input: RunDurableGraphInput,
  node: WorkflowNode,
  context: Readonly<Record<string, unknown>>,
): DurableGraphCapabilityEnvelope => ({
  inputs: input.inputs,
  context,
  node,
  policySnapshot: input.policySnapshot,
});

const preflightCapabilityRegistry = (
  graph: DurableWorkflowGraph,
  registry: Readonly<Record<string, DurableGraphCapabilityEntry>>,
): void => {
  for (const node of graph.nodes) {
    if (node.kind !== "capability" && node.kind !== "agent") {
      continue;
    }

    const key =
      node.kind === "agent" ? (node.agent ?? node.capability) : node.capability;
    if (!key || !registry[key]) {
      throw makePublicError(
        "VALIDATION_FAILED",
        `Missing workflow capability ref: ${key ?? ""}`,
        { nodeId: node.id },
      );
    }

    if (node.kind === "agent" && registry[key]?.agentSeat !== true) {
      throw makePublicError(
        "VALIDATION_FAILED",
        `Agent node is not tagged as an agent seat: ${key}`,
        { nodeId: node.id },
      );
    }
  }
};

const isEdgeActive = (
  edge: WorkflowEdge,
  input: RunDurableGraphInput,
  context: Readonly<Record<string, unknown>>,
): boolean =>
  edge.condition
    ? evaluateSafeConditionExpression(edge.condition.expression, {
        inputs: input.inputs,
        context,
        policySnapshot: input.policySnapshot,
      })
    : true;

const isNodeReady = (
  node: WorkflowNode,
  incomingByNode: ReadonlyMap<string, readonly WorkflowEdge[]>,
  joinsByNode: ReadonlyMap<string, WorkflowJoin>,
  passedEdges: ReadonlySet<string>,
  failedEdges: ReadonlySet<string>,
): boolean => {
  const incoming = incomingByNode.get(node.id) ?? [];
  const join = joinsByNode.get(node.id);

  if (join?.strategy === "all-successful") {
    return join.sourceNodeIds.every((sourceNodeId) =>
      incoming.some(
        (edge) =>
          edge.sourceNodeId === sourceNodeId && passedEdges.has(edge.id),
      ),
    );
  }

  if (join?.strategy === "any-successful") {
    return join.sourceNodeIds.some((sourceNodeId) =>
      incoming.some(
        (edge) =>
          edge.sourceNodeId === sourceNodeId && passedEdges.has(edge.id),
      ),
    );
  }

  return (
    incoming.length === 0 ||
    (incoming.some((edge) => passedEdges.has(edge.id)) &&
      incoming.every(
        (edge) => passedEdges.has(edge.id) || failedEdges.has(edge.id),
      ))
  );
};

const groupEdgesBySource = (
  edges: readonly WorkflowEdge[],
): ReadonlyMap<string, readonly WorkflowEdge[]> => {
  const grouped = new Map<string, WorkflowEdge[]>();
  for (const edge of edges) {
    grouped.set(edge.sourceNodeId, [
      ...(grouped.get(edge.sourceNodeId) ?? []),
      edge,
    ]);
  }
  return grouped;
};

const groupEdgesByTarget = (
  edges: readonly WorkflowEdge[],
): ReadonlyMap<string, readonly WorkflowEdge[]> => {
  const grouped = new Map<string, WorkflowEdge[]>();
  for (const edge of edges) {
    grouped.set(edge.targetNodeId, [
      ...(grouped.get(edge.targetNodeId) ?? []),
      edge,
    ]);
  }
  return grouped;
};

const assertJsonObject = (value: unknown, message: string): void => {
  if (!isJsonRecord(value)) {
    throw makePublicError("VALIDATION_FAILED", message);
  }
  assertJsonSafe(value, message);
};

const assertJsonSafe = (value: unknown, message: string): void => {
  if (!isJsonSafe(value)) {
    throw makePublicError("VALIDATION_FAILED", message);
  }
};

const isJsonRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

const isJsonSafe = (value: unknown): boolean => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonSafe);
  }
  if (isJsonRecord(value)) {
    return Object.values(value).every(
      (entry) => entry !== undefined && isJsonSafe(entry),
    );
  }
  return false;
};
