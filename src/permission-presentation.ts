import type { RequestPermissionRequest, ToolCallLocation } from "@agentclientprotocol/sdk";
import { toolInfoFromToolUse } from "./tools.js";

export interface ClaudePermissionPresentationInput {
  toolName: string;
  input: Record<string, unknown>;
  toolUseID: string;
  cwd?: string;
  supportsTerminalOutput?: boolean;
  blockedPath?: string;
  title?: string;
  displayName?: string;
  description?: string;
  decisionReason?: string;
}

function nonBlankString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.trim() ? value : undefined;
}

function withBlockedPath(
  locations: ToolCallLocation[] | undefined,
  blockedPath: unknown,
): ToolCallLocation[] | undefined {
  const path = nonBlankString(blockedPath);
  if (!path) return locations;
  const result = [...(locations ?? [])];
  if (!result.some((location) => location.path === path)) result.push({ path });
  return result;
}

export function buildClaudePermissionPresentation(
  value: ClaudePermissionPresentationInput,
): Pick<RequestPermissionRequest, "toolCall" | "_meta"> {
  const info = toolInfoFromToolUse(
    { id: value.toolUseID, name: value.toolName, input: value.input },
    value.supportsTerminalOutput ?? false,
    value.cwd,
  );
  const title = nonBlankString(value.title) ?? nonBlankString(value.displayName);
  const description = nonBlankString(value.description) ?? nonBlankString(value.decisionReason);
  return {
    toolCall: {
      toolCallId: value.toolUseID,
      name: value.toolName,
      status: "pending",
      rawInput: value.input,
      ...info,
      locations: withBlockedPath(info.locations, value.blockedPath),
    },
    ...(title
      ? {
          _meta: {
            permission: {
              version: 1,
              title,
              ...(description ? { description } : {}),
            },
          },
        }
      : {}),
  };
}
