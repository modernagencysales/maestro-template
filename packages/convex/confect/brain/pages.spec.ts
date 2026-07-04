import { FunctionSpec, GroupSpec } from "@confect/core";
import * as Schema from "effect/Schema";
import {
  MemberNotInWorkspace,
  Unauthorized,
  WorkspaceNotFound,
} from "../errors";
import { Id } from "../_generated/id";
import brainPages from "../_generated/tables/brainPages";
import {
  collectContractManifest,
  collectContractSchemas,
  defineContractFunction,
} from "../capabilities/_kit/capability";

const BrainPageError = Schema.Union(
  Unauthorized,
  MemberNotInWorkspace,
  WorkspaceNotFound,
);

const ListArgs = Schema.Struct({
  workspaceId: Id("workspaces"),
});

const ListReturns = Schema.Array(brainPages.Doc);

const CreateMarkdownArgs = Schema.Struct({
  workspaceId: Id("workspaces"),
  slug: Schema.String,
  title: Schema.String,
  markdown: Schema.String,
});

const CreateMarkdownReturns = Id("brainPages");

const list = defineContractFunction(
  FunctionSpec.publicQuery({
    name: "list",
    args: () => ListArgs,
    returns: () => ListReturns,
    error: () => BrainPageError,
  }),
  {
    namespace: "brain.pages",
    name: "list",
    operationId: "brain.pages.list",
    kind: "query",
    surfaces: ["web"],
    typedErrors: ["Unauthorized", "MemberNotInWorkspace", "WorkspaceNotFound"],
    idempotent: true,
    argsSchemaName: "brain.pages.list.args",
    returnsSchemaName: "brain.pages.list.returns",
    argsSchema: ListArgs,
    returnsSchema: ListReturns,
  },
);

const createMarkdown = defineContractFunction(
  FunctionSpec.publicMutation({
    name: "createMarkdown",
    args: () => CreateMarkdownArgs,
    returns: () => CreateMarkdownReturns,
    error: () => BrainPageError,
  }),
  {
    namespace: "brain.pages",
    name: "createMarkdown",
    operationId: "brain.pages.createMarkdown",
    kind: "mutation",
    surfaces: ["web", "api", "cli", "mcp"],
    typedErrors: ["Unauthorized", "MemberNotInWorkspace", "WorkspaceNotFound"],
    idempotent: false,
    argsSchemaName: "brain.pages.createMarkdown.args",
    returnsSchemaName: "brain.pages.createMarkdown.returns",
    argsSchema: CreateMarkdownArgs,
    returnsSchema: CreateMarkdownReturns,
  },
);

const contractFunctions = [list, createMarkdown] as const;

export const manifest = collectContractManifest(contractFunctions);
export const schemaRegistry = collectContractSchemas(contractFunctions);

export default GroupSpec.make()
  .addFunction(list.spec)
  .addFunction(createMarkdown.spec);
