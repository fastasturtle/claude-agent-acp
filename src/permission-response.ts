import type { RequestPermissionResponse } from "@agentclientprotocol/sdk";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { DurablePermissionChangeSet } from "./permission-normalization.js";
import { PERMISSION_OPTION_ID } from "./permission-options.js";

export function mapClaudePermissionResponse(
  response: RequestPermissionResponse,
  input: Record<string, unknown>,
  toolUseID: string,
  durableChangeSet?: DurablePermissionChangeSet,
): PermissionResult {
  if (response.outcome?.outcome !== "selected") throw new Error("Tool use aborted");
  switch (response.outcome.optionId) {
    case PERMISSION_OPTION_ID.allowOnce:
      return {
        behavior: "allow",
        updatedInput: input,
        toolUseID,
        decisionClassification: "user_temporary",
      };
    case PERMISSION_OPTION_ID.allowWithUpdates:
      if (!durableChangeSet) throw new Error("Invalid durable permission selection");
      return {
        behavior: "allow",
        updatedInput: input,
        updatedPermissions: durableChangeSet.updates,
        toolUseID,
        decisionClassification: "user_permanent",
      };
    case PERMISSION_OPTION_ID.reject:
      return {
        behavior: "deny",
        message: "User refused permission to run tool",
        toolUseID,
        decisionClassification: "user_reject",
      };
    default:
      throw new Error(`Unknown permission option: ${response.outcome.optionId}`);
  }
}
