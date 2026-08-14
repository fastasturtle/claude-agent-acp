import type { PermissionOption } from "@agentclientprotocol/sdk";
import type { DurablePermissionChangeSet } from "./permission-normalization.js";

export const PERMISSION_OPTION_ID = {
  allowOnce: "allow-once",
  allowWithUpdates: "allow-with-updates",
  reject: "reject",
} as const;

export function buildClaudePermissionOptions(
  durableChangeSet?: DurablePermissionChangeSet,
): PermissionOption[] {
  const options: PermissionOption[] = [
    { optionId: PERMISSION_OPTION_ID.allowOnce, name: "Allow once", kind: "allow_once" },
  ];
  if (durableChangeSet) {
    options.push({
      optionId: PERMISSION_OPTION_ID.allowWithUpdates,
      name: "Allow and update permissions",
      kind: "allow_always",
      _meta: {
        permission: {
          version: 1,
          description: durableChangeSet.description,
        },
      },
    });
  }
  options.push({ optionId: PERMISSION_OPTION_ID.reject, name: "Reject", kind: "reject_once" });
  return options;
}
