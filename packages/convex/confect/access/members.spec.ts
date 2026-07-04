import { FunctionSpec, GroupSpec } from "@confect/core";
import * as Schema from "effect/Schema";

import { Id } from "../_generated/id";
import {
  Forbidden,
  InvitationExpired,
  InvitationNotAccessible,
  InvitationNotPending,
  LastOwnerProtected,
  MemberNotInWorkspace,
  Unauthorized,
  ValidationFailed,
} from "../errors";
import { Role } from "./roles";

const changeRole = FunctionSpec.publicMutation({
  name: "changeRole",
  args: () =>
    Schema.Struct({
      membershipId: Id("workspaceMembers"),
      newRole: Role,
    }),
  returns: () => Schema.Null,
  error: () =>
    Schema.Union(
      Unauthorized,
      Forbidden,
      InvitationExpired,
      InvitationNotAccessible,
      InvitationNotPending,
      MemberNotInWorkspace,
      LastOwnerProtected,
      ValidationFailed,
    ),
});

const remove = FunctionSpec.publicMutation({
  name: "remove",
  args: () =>
    Schema.Struct({
      membershipId: Id("workspaceMembers"),
    }),
  returns: () => Schema.Null,
  error: () =>
    Schema.Union(
      Unauthorized,
      Forbidden,
      InvitationExpired,
      InvitationNotAccessible,
      InvitationNotPending,
      MemberNotInWorkspace,
      LastOwnerProtected,
      ValidationFailed,
    ),
});

const transferOwnership = FunctionSpec.publicMutation({
  name: "transferOwnership",
  args: () =>
    Schema.Struct({
      membershipId: Id("workspaceMembers"),
    }),
  returns: () => Schema.Null,
  error: () =>
    Schema.Union(
      Unauthorized,
      Forbidden,
      InvitationExpired,
      InvitationNotAccessible,
      InvitationNotPending,
      MemberNotInWorkspace,
      LastOwnerProtected,
      ValidationFailed,
    ),
});

export default GroupSpec.make()
  .addFunction(changeRole)
  .addFunction(remove)
  .addFunction(transferOwnership);
