import { FunctionSpec, GroupSpec } from "@confect/core";
import * as Schema from "effect/Schema";
import {
  MemberNotInWorkspace,
  Unauthorized,
  WorkspaceNotFound,
} from "../errors";
import { Id } from "../_generated/id";
import brainPages from "../_generated/tables/brainPages";

const BrainPageError = Schema.Union(
  Unauthorized,
  MemberNotInWorkspace,
  WorkspaceNotFound,
);

const list = FunctionSpec.publicQuery({
  name: "list",
  args: () =>
    Schema.Struct({
      workspaceId: Id("workspaces"),
    }),
  returns: () => Schema.Array(brainPages.Doc),
  error: () => BrainPageError,
});

const createMarkdown = FunctionSpec.publicMutation({
  name: "createMarkdown",
  args: () =>
    Schema.Struct({
      workspaceId: Id("workspaces"),
      slug: Schema.String,
      title: Schema.String,
      markdown: Schema.String,
    }),
  returns: () => Id("brainPages"),
  error: () => BrainPageError,
});

export default GroupSpec.make().addFunction(list).addFunction(createMarkdown);
