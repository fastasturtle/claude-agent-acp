import type {
  PermissionBehavior,
  PermissionMode,
  PermissionUpdate,
  PermissionUpdateDestination,
} from "@anthropic-ai/claude-agent-sdk";

export interface DurablePermissionChangeSet {
  updates: PermissionUpdate[];
  description: string;
}

const DESTINATIONS = new Set<PermissionUpdateDestination>([
  "session",
  "cliArg",
  "userSettings",
  "projectSettings",
  "localSettings",
]);
const BEHAVIORS = new Set<PermissionBehavior>(["allow", "deny", "ask"]);
const MODES = new Set<PermissionMode>([
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "dontAsk",
  "auto",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isDestination(value: unknown): value is PermissionUpdateDestination {
  return typeof value === "string" && DESTINATIONS.has(value as PermissionUpdateDestination);
}

function isRule(value: unknown): value is { toolName: string; ruleContent?: string } {
  if (!isRecord(value) || typeof value.toolName !== "string" || plain(value.toolName) === "") {
    return false;
  }
  return (
    value.ruleContent === undefined ||
    (typeof value.ruleContent === "string" && plain(value.ruleContent) !== "")
  );
}

function isKnownUpdate(value: unknown): value is PermissionUpdate {
  if (!isRecord(value) || !isDestination(value.destination) || typeof value.type !== "string") {
    return false;
  }
  switch (value.type) {
    case "addRules":
    case "replaceRules":
    case "removeRules":
      return (
        Array.isArray(value.rules) &&
        (value.type === "replaceRules" || value.rules.length > 0) &&
        value.rules.every(isRule) &&
        typeof value.behavior === "string" &&
        BEHAVIORS.has(value.behavior as PermissionBehavior)
      );
    case "setMode":
      return typeof value.mode === "string" && MODES.has(value.mode as PermissionMode);
    case "addDirectories":
    case "removeDirectories":
      return (
        Array.isArray(value.directories) &&
        value.directories.length > 0 &&
        value.directories.every(
          (directory) => typeof directory === "string" && plain(directory) !== "",
        )
      );
    default:
      return false;
  }
}

function plain(value: string): string {
  return value.trim();
}

function unsupportedPermissionValue(value: never): never {
  throw new Error(`Unsupported permission value: ${JSON.stringify(value)}`);
}

function destinationText(destination: PermissionUpdateDestination): string {
  switch (destination) {
    case "session":
      return "for the current Claude session";
    case "cliArg":
      return "for this Claude process";
    case "userSettings":
      return "persistently in user settings";
    case "projectSettings":
      return "persistently in shared project settings";
    case "localSettings":
      return "persistently in local-project settings";
    default:
      return unsupportedPermissionValue(destination);
  }
}

function rulesText(rules: Array<{ toolName: string; ruleContent?: string }>): string {
  if (rules.length === 0) return "no rules";
  return rules
    .map((rule) => {
      const toolName = plain(rule.toolName);
      const matcher = rule.ruleContent === undefined ? undefined : plain(rule.ruleContent);
      return matcher ? `${toolName} calls matching “${matcher}”` : `all ${toolName} calls`;
    })
    .join(", ");
}

function describeUpdate(update: PermissionUpdate): string {
  const destination = destinationText(update.destination);
  switch (update.type) {
    case "addRules": {
      const verb =
        update.behavior === "allow" ? "Allow" : update.behavior === "deny" ? "Deny" : "Ask before";
      return `${verb} ${rulesText(update.rules)} ${destination}.`;
    }
    case "replaceRules":
      return `Replace ${update.behavior} rules with ${rulesText(update.rules)} ${destination}.`;
    case "removeRules":
      return `Remove ${update.behavior} rules for ${rulesText(update.rules)} ${destination}.`;
    case "setMode":
      return `Set Claude permission mode to ${update.mode} ${destination}.`;
    case "addDirectories":
      return `Add filesystem access to ${update.directories.map(plain).join(", ")} ${destination}.`;
    case "removeDirectories":
      return `Remove filesystem access to ${update.directories.map(plain).join(", ")} ${destination}.`;
    default:
      return unsupportedPermissionValue(update);
  }
}

export function normalizeDurablePermissionChangeSet(
  suggestions: unknown,
  forcedAsk = false,
): DurablePermissionChangeSet | undefined {
  if (
    !Array.isArray(suggestions) ||
    suggestions.length === 0 ||
    !suggestions.every(isKnownUpdate)
  ) {
    return undefined;
  }
  const updates = suggestions as PermissionUpdate[];
  if (forcedAsk) return undefined;
  return {
    updates,
    description: updates.map(describeUpdate).join(" "),
  };
}
