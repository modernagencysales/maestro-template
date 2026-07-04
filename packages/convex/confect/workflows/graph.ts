import * as S from "effect/Schema";

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

export const validateWorkflowGraph = (
  graph: DurableWorkflowGraph,
): readonly WorkflowGraphValidationError[] => {
  const errors: WorkflowGraphValidationError[] = [];
  const nodeIds = new Set<string>();
  const duplicateNodeIds = new Set<string>();
  const edgeIds = new Set<string>();
  const duplicateEdgeIds = new Set<string>();

  for (const node of graph.nodes) {
    if (nodeIds.has(node.id)) {
      duplicateNodeIds.add(node.id);
    }
    nodeIds.add(node.id);

    if (node.retry.maxAttempts < 1) {
      errors.push(
        new WorkflowGraphValidationError.InvalidRetryConfig({
          nodeId: node.id,
          field: "maxAttempts",
        }),
      );
    }

    if (node.retry.backoffMs < 0) {
      errors.push(
        new WorkflowGraphValidationError.InvalidRetryConfig({
          nodeId: node.id,
          field: "backoffMs",
        }),
      );
    }

    if (
      node.kind === "delay" &&
      (!Number.isInteger(node.delayMs) || (node.delayMs ?? 0) <= 0)
    ) {
      errors.push(
        new WorkflowGraphValidationError.InvalidDelayConfig({
          nodeId: node.id,
          field: "delayMs",
        }),
      );
    }
  }

  for (const nodeId of duplicateNodeIds) {
    errors.push(new WorkflowGraphValidationError.DuplicateNodeId({ nodeId }));
  }

  if (!nodeIds.has(graph.startNodeId)) {
    errors.push(
      new WorkflowGraphValidationError.MissingStartNode({
        startNodeId: graph.startNodeId,
      }),
    );
  }

  const edgeKeys = new Set<string>();
  for (const edge of graph.edges) {
    if (edgeIds.has(edge.id)) {
      duplicateEdgeIds.add(edge.id);
    }
    edgeIds.add(edge.id);
    edgeKeys.add(`${edge.sourceNodeId}\0${edge.targetNodeId}`);

    if (!nodeIds.has(edge.sourceNodeId)) {
      errors.push(
        new WorkflowGraphValidationError.DanglingEdge({
          edgeId: edge.id,
          nodeId: edge.sourceNodeId,
        }),
      );
    }

    if (!nodeIds.has(edge.targetNodeId)) {
      errors.push(
        new WorkflowGraphValidationError.DanglingEdge({
          edgeId: edge.id,
          nodeId: edge.targetNodeId,
        }),
      );
    }

    if (
      edge.condition &&
      !isSafeConditionExpression(edge.condition.expression)
    ) {
      errors.push(
        new WorkflowGraphValidationError.InvalidConditionExpression({
          edgeId: edge.id,
        }),
      );
    }
  }

  for (const edgeId of duplicateEdgeIds) {
    errors.push(new WorkflowGraphValidationError.DuplicateEdgeId({ edgeId }));
  }

  for (const join of graph.joins) {
    if (!nodeIds.has(join.nodeId)) {
      errors.push(
        new WorkflowGraphValidationError.InvalidJoin({
          nodeId: join.nodeId,
          reason: "join node is not in graph",
        }),
      );
    }

    for (const sourceNodeId of join.sourceNodeIds) {
      if (!nodeIds.has(sourceNodeId)) {
        errors.push(
          new WorkflowGraphValidationError.InvalidJoin({
            nodeId: sourceNodeId,
            reason: "join source node is not in graph",
          }),
        );
        continue;
      }

      if (
        nodeIds.has(join.nodeId) &&
        !edgeKeys.has(`${sourceNodeId}\0${join.nodeId}`)
      ) {
        errors.push(
          new WorkflowGraphValidationError.InvalidJoin({
            nodeId: join.nodeId,
            reason: `join source node ${sourceNodeId} has no edge to join node`,
          }),
        );
      }
    }
  }

  return errors;
};

type ConditionToken =
  | { readonly type: "identifier"; readonly value: string }
  | { readonly type: "string"; readonly value: string }
  | { readonly type: "number"; readonly value: number }
  | {
      readonly type: "operator";
      readonly value: "===" | "!==" | "&&" | "||" | "!";
    }
  | { readonly type: "paren"; readonly value: "(" | ")" }
  | { readonly type: "eof" };

type ConditionAst =
  | { readonly type: "identifier"; readonly path: readonly string[] }
  | { readonly type: "literal"; readonly value: string | number }
  | {
      readonly type: "binary";
      readonly operator: "===" | "!==" | "&&" | "||";
      readonly left: ConditionAst;
      readonly right: ConditionAst;
    }
  | { readonly type: "not"; readonly expression: ConditionAst };

export type WorkflowConditionContext = {
  readonly inputs: unknown;
  readonly context: Readonly<Record<string, unknown>>;
  readonly policySnapshot: unknown;
};

export const isSafeConditionExpression = (expression: string): boolean => {
  try {
    parseConditionExpression(expression);
    return true;
  } catch {
    return false;
  }
};

export const evaluateSafeConditionExpression = (
  expression: string,
  conditionContext: WorkflowConditionContext,
): boolean => {
  const ast = parseConditionExpression(expression);
  return Boolean(evaluateConditionAst(ast, conditionContext));
};

const parseConditionExpression = (expression: string): ConditionAst => {
  const parser = new ConditionParser(tokenizeConditionExpression(expression));
  const ast = parser.parseExpression();
  parser.expectEof();
  return ast;
};

const tokenizeConditionExpression = (
  expression: string,
): readonly ConditionToken[] => {
  const tokens: ConditionToken[] = [];
  let index = 0;

  while (index < expression.length) {
    const char = expression[index];

    if (!char) {
      break;
    }

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    const three = expression.slice(index, index + 3);
    if (three === "===" || three === "!==") {
      tokens.push({ type: "operator", value: three });
      index += 3;
      continue;
    }

    const two = expression.slice(index, index + 2);
    if (two === "&&" || two === "||") {
      tokens.push({ type: "operator", value: two });
      index += 2;
      continue;
    }

    if (char === "=") {
      throw new Error("assignments and loose equality are not allowed");
    }

    if (char === "!") {
      if (expression[index + 1] === "=") {
        throw new Error("loose inequality is not allowed");
      }
      tokens.push({ type: "operator", value: "!" });
      index += 1;
      continue;
    }

    if (char === "(" || char === ")") {
      tokens.push({ type: "paren", value: char });
      index += 1;
      continue;
    }

    if (char === "'" || char === '"') {
      const result = readStringLiteral(expression, index, char);
      tokens.push({ type: "string", value: result.value });
      index = result.nextIndex;
      continue;
    }

    if (/[0-9]/.test(char)) {
      const match = /^[0-9]+(?:\.[0-9]+)?/.exec(expression.slice(index));
      if (!match) {
        throw new Error("invalid number literal");
      }
      tokens.push({ type: "number", value: Number(match[0]) });
      index += match[0].length;
      continue;
    }

    if (/[A-Za-z_]/.test(char)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/.exec(
        expression.slice(index),
      );
      if (!match) {
        throw new Error("invalid identifier");
      }
      tokens.push({ type: "identifier", value: match[0] });
      index += match[0].length;
      continue;
    }

    throw new Error(`unsupported condition token: ${char}`);
  }

  tokens.push({ type: "eof" });
  return tokens;
};

const readStringLiteral = (
  expression: string,
  startIndex: number,
  quote: "'" | '"',
): { readonly value: string; readonly nextIndex: number } => {
  let value = "";
  let index = startIndex + 1;

  while (index < expression.length) {
    const char = expression[index];
    if (char === quote) {
      return { value, nextIndex: index + 1 };
    }
    if (char === "\\") {
      const escaped = expression[index + 1];
      if (!escaped || !["\\", "'", '"', "n", "r", "t"].includes(escaped)) {
        throw new Error("unsupported string escape");
      }
      value +=
        escaped === "n"
          ? "\n"
          : escaped === "r"
            ? "\r"
            : escaped === "t"
              ? "\t"
              : escaped;
      index += 2;
      continue;
    }
    value += char;
    index += 1;
  }

  throw new Error("unterminated string literal");
};

class ConditionParser {
  private index = 0;

  constructor(private readonly tokens: readonly ConditionToken[]) {}

  parseExpression(): ConditionAst {
    return this.parseOr();
  }

  expectEof(): void {
    if (this.peek().type !== "eof") {
      throw new Error("unexpected trailing condition token");
    }
  }

  private parseOr(): ConditionAst {
    let ast = this.parseAnd();
    while (this.matchOperator("||")) {
      ast = {
        type: "binary",
        operator: "||",
        left: ast,
        right: this.parseAnd(),
      };
    }
    return ast;
  }

  private parseAnd(): ConditionAst {
    let ast = this.parseEquality();
    while (this.matchOperator("&&")) {
      ast = {
        type: "binary",
        operator: "&&",
        left: ast,
        right: this.parseEquality(),
      };
    }
    return ast;
  }

  private parseEquality(): ConditionAst {
    let ast = this.parseUnary();
    const token = this.peek();
    if (
      token.type === "operator" &&
      (token.value === "===" || token.value === "!==")
    ) {
      this.index += 1;
      ast = {
        type: "binary",
        operator: token.value,
        left: ast,
        right: this.parseUnary(),
      };
    }
    return ast;
  }

  private parseUnary(): ConditionAst {
    if (this.matchOperator("!")) {
      return { type: "not", expression: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): ConditionAst {
    const token = this.peek();
    if (token.type === "identifier") {
      this.index += 1;
      const path = token.value.split(".");
      const root = path[0];
      if (
        root !== "inputs" &&
        root !== "context" &&
        root !== "policySnapshot"
      ) {
        throw new Error(`unsupported condition identifier: ${root ?? ""}`);
      }
      if (path.includes("constructor") || path.includes("__proto__")) {
        throw new Error("constructor and prototype access are not allowed");
      }
      return { type: "identifier", path };
    }
    if (token.type === "string" || token.type === "number") {
      this.index += 1;
      return { type: "literal", value: token.value };
    }
    if (token.type === "paren" && token.value === "(") {
      this.index += 1;
      const ast = this.parseExpression();
      const closing = this.peek();
      if (closing.type !== "paren" || closing.value !== ")") {
        throw new Error("missing closing parenthesis");
      }
      this.index += 1;
      return ast;
    }
    throw new Error("expected condition primary expression");
  }

  private matchOperator(operator: "===" | "!==" | "&&" | "||" | "!"): boolean {
    const token = this.peek();
    if (token.type === "operator" && token.value === operator) {
      this.index += 1;
      return true;
    }
    return false;
  }

  private peek(): ConditionToken {
    return this.tokens[this.index] ?? { type: "eof" };
  }
}

const evaluateConditionAst = (
  ast: ConditionAst,
  conditionContext: WorkflowConditionContext,
): unknown => {
  switch (ast.type) {
    case "identifier":
      return readConditionPath(conditionContext, ast.path);
    case "literal":
      return ast.value;
    case "not":
      return !evaluateConditionAst(ast.expression, conditionContext);
    case "binary": {
      if (ast.operator === "&&") {
        return (
          Boolean(evaluateConditionAst(ast.left, conditionContext)) &&
          Boolean(evaluateConditionAst(ast.right, conditionContext))
        );
      }
      if (ast.operator === "||") {
        return (
          Boolean(evaluateConditionAst(ast.left, conditionContext)) ||
          Boolean(evaluateConditionAst(ast.right, conditionContext))
        );
      }
      const left = evaluateConditionAst(ast.left, conditionContext);
      const right = evaluateConditionAst(ast.right, conditionContext);
      return ast.operator === "===" ? left === right : left !== right;
    }
  }
};

const readConditionPath = (
  conditionContext: WorkflowConditionContext,
  path: readonly string[],
): unknown => {
  let value: unknown =
    path[0] === "inputs"
      ? conditionContext.inputs
      : path[0] === "context"
        ? conditionContext.context
        : conditionContext.policySnapshot;

  for (const segment of path.slice(1)) {
    if (value === null || typeof value !== "object") {
      return undefined;
    }
    value = (value as Record<string, unknown>)[segment];
  }

  return value;
};
