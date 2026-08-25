/**
 * `authStatus` — interim `_meta`-based ACP extension that reports which auth
 * identity the agent process itself uses (Claude subscription, API key,
 * gateway, external cloud credentials, or nothing).
 *
 * Two carriers, both connection-scoped (never per session):
 * - pull: request `auth/status` → `{_meta: {authStatus}}`, or `{}` when the
 *   state cannot be determined;
 * - push: notification `auth/status_update` → `{authStatus}` whenever the
 *   value changes.
 *
 * Reporting only — there is no write path in v1. When the upstream RFD lands,
 * the same payload moves from `_meta` to first-class fields and this module
 * is retired.
 */

import { RequestError } from "@agentclientprotocol/sdk";
import type { AccountInfo } from "@anthropic-ai/claude-agent-sdk";

/** Pull request, client → agent. */
export const AUTH_STATUS_METHOD = "auth/status";
/** Change notification, agent → client. Fire and forget: clients that do not
 *  know the method drop it silently, so it is sent unconditionally. */
export const AUTH_STATUS_UPDATE_METHOD = "auth/status_update";

export type AuthStatusKind = "account" | "api_key" | "gateway" | "external" | "none";

export type AuthStatusAccount = {
  email?: string;
  organization?: string;
  /** Vendor plan/license string, not normalized. */
  plan?: string;
};

export type AuthStatus = {
  kind: AuthStatusKind;
  /** Human-readable and usable as a UI string on its own. The "type" line:
   *  "Claude Max", "Anthropic API key", "AWS Bedrock". */
  label: string;
  /** Optional second line carrying the specifics (key source, gateway host, …).
   *  Clients render it under `label`, falling back to `account.email`. */
  detail?: string;
  account?: AuthStatusAccount;
  /** Vendor-namespaced extras, e.g. `{claudeCode: {...}}`. */
  vendor?: Record<string, unknown>;
};

/** Params of `auth/status`: none. */
export type AuthStatusRequest = Record<string, never>;

/** The payload alone is the state machine: present (any `kind`, `none`
 *  included) means the agent knows; absent means it could not determine. */
export type AuthStatusResponse = {
  /** Omitted when the agent could not determine its own state; clients treat
   *  a missing payload as "not reported". */
  _meta?: { authStatus: AuthStatus };
};

export type AuthStatusUpdateNotification = { authStatus: AuthStatus };

/** Advertisement carried in `agentCapabilities._meta.authStatus`, never a
 *  status payload: its mere presence means "supported", and it stays empty.
 *  Clients call `auth/status` only when they see it, so agents without the
 *  extension are not spammed with "method not found" errors. */
export type AuthStatusCapability = Record<string, never>;

export function authStatusCapability(): AuthStatusCapability {
  return {};
}

/** Shape of `claude auth status --json`. Absent fields are omitted, not null,
 *  and the logged-out case exits 1 while still printing valid JSON. */
export type CliAuthStatus = {
  loggedIn?: boolean;
  authMethod?: string;
  apiProvider?: string;
  apiKeySource?: string;
  email?: string;
  orgId?: string;
  orgName?: string;
  subscriptionType?: string;
};

const NOT_LOGGED_IN: AuthStatus = {
  kind: "none",
  label: "Not logged in",
};

/** Display names for the non-firstParty backends, where auth lives outside the
 *  agent (AWS credentials, gcloud ADC, …). */
const EXTERNAL_PROVIDER_LABELS: Record<string, string> = {
  bedrock: "AWS Bedrock",
  vertex: "Google Vertex AI",
  foundry: "Azure AI Foundry",
  anthropicAws: "Anthropic on AWS",
  anthropicGoogleCloud: "Anthropic on Google Cloud",
  mantle: "Mantle",
};

export function notLoggedInAuthStatus(): AuthStatus {
  return { ...NOT_LOGGED_IN };
}

/** ACP-level gateway auth (`authenticate` with `gateway`/`gateway-bedrock`).
 *  The gateway owns the credentials, so it wins over anything the CLI reports. */
export function gatewayAuthStatus(baseUrl?: string): AuthStatus {
  let host: string | undefined;
  if (baseUrl) {
    try {
      host = new URL(baseUrl).host;
    } catch {
      host = baseUrl;
    }
  }
  return {
    kind: "gateway",
    label: "Custom model gateway",
    ...(host ? { detail: host } : {}),
  };
}

/**
 * Does this `AccountInfo` say anything about the identity?
 *
 * The SDK always fills `apiProvider`, but the identity fields come from the
 * claude.ai profile: with an `apiKeyHelper` and no subscription login the
 * session reports `{apiProvider: "firstParty"}` and nothing else. That is "no
 * information", not "logged out" — an empty read must never be mapped to
 * `none`, or it destroys what the CLI probe already established.
 *
 * `tokenSource` is deliberately not a signal: the CLI sets it to the OAuth
 * token's origin (`CLAUDE_CODE_OAUTH_TOKEN`,
 * `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR`, …), never to a key source, so it
 * cannot attribute a key and carries no plan of its own.
 */
export function accountInfoHasIdentitySignal(account: AccountInfo | undefined): boolean {
  if (!account) return false;
  return Boolean(
    account.apiKeySource ||
    account.subscriptionType ||
    (account.apiProvider && account.apiProvider !== "firstParty"),
  );
}

/** Session-time mapping from the SDK's `AccountInfo`, the richest source when
 *  it is populated. Returns `undefined` when the account carries no identity
 *  signal, so callers keep the status they already know. */
export function fromAccountInfo(account: AccountInfo | undefined): AuthStatus | undefined {
  if (!account || !accountInfoHasIdentitySignal(account)) {
    return undefined;
  }
  return mapAuthFields({
    apiProvider: account.apiProvider,
    subscriptionType: account.subscriptionType,
    apiKeySource: account.apiKeySource,
    email: account.email,
    organization: account.organization,
  });
}

/** Pre-session mapping from `claude auth status --json` stdout. Returns
 *  `undefined` when the output is not the expected JSON object, so callers can
 *  report "not known" instead of guessing. */
export function fromCliStatus(stdout: string): AuthStatus | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const status = parsed as CliAuthStatus;
  if (typeof status.loggedIn !== "boolean") {
    return undefined;
  }
  // `loggedIn` tracks the claude.ai login only. On a 3P backend (Bedrock,
  // Vertex, …) it is false while the credentials live outside the agent, so the
  // backend must decide the kind before the logged-out shortcut runs.
  const externalBackend = Boolean(status.apiProvider && status.apiProvider !== "firstParty");
  if (!externalBackend && !status.loggedIn && !status.apiKeySource) {
    return notLoggedInAuthStatus();
  }
  return mapAuthFields({
    apiProvider: status.apiProvider,
    subscriptionType: status.subscriptionType,
    apiKeySource: status.apiKeySource,
    email: status.email,
    organization: status.orgName,
  });
}

/** Single mapping table shared by both sources; see the `kind`/`label` table in
 *  `extension-authstatus-meta.md`. Order matters: a 3P backend or a gateway
 *  decides the kind before any firstParty identity fields are considered, and
 *  an API key outranks a stored subscription login.
 *
 *  Both can be reported at once — an `apiKeyHelper` in settings.json next to a
 *  claude.ai OAuth login yields `apiKeySource` AND `subscriptionType`. Claude
 *  Code's authentication precedence puts `apiKeyHelper` above the `/login`
 *  subscription, so the key is what actually pays for the turn and is what we
 *  report. */
function mapAuthFields(fields: {
  apiProvider?: string;
  subscriptionType?: string;
  apiKeySource?: string;
  email?: string;
  organization?: string;
}): AuthStatus {
  const { apiProvider, subscriptionType, apiKeySource, email, organization } = fields;

  if (apiProvider === "gateway") {
    return gatewayAuthStatus();
  }
  if (apiProvider && apiProvider !== "firstParty") {
    return {
      kind: "external",
      label: EXTERNAL_PROVIDER_LABELS[apiProvider] ?? apiProvider,
    };
  }
  if (apiKeySource) {
    return {
      kind: "api_key",
      label: "Anthropic API key",
      // The source ("apiKeyHelper", "env", …) is the specifics line.
      detail: apiKeySource,
    };
  }
  if (subscriptionType) {
    // `account.plan` keeps the raw vendor string; only the label is titled.
    const account: AuthStatusAccount = { plan: subscriptionType };
    if (email) account.email = email;
    if (organization) account.organization = organization;
    return {
      kind: "account",
      label: `Claude ${capitalize(subscriptionType)}`,
      // No detail: the client falls back to `account.email` for line 2.
      account,
    };
  }
  return notLoggedInAuthStatus();
}

/** Title-cases the vendor plan string for the label ("max" → "Max"). Left alone
 *  when it already carries capitals ("Max", "Team Premium"). */
function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Do two payloads describe the same login? Compared on the field that
 * identifies each kind — the key source for `api_key`, the email for
 * `account`, the kind alone for the rest, which carry no per-identity key.
 */
export function sameIdentity(a: AuthStatus, b: AuthStatus): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  switch (a.kind) {
    case "api_key":
      return a.detail === b.detail;
    case "account":
      return (a.account?.email ?? "") === (b.account?.email ?? "");
    default:
      return true;
  }
}

/**
 * Folds a fresh read into what is already known. Sources differ in richness for
 * the very same login: the SDK's session `AccountInfo` can carry an
 * organization the CLI probe omits. So when the read describes the same
 * identity, its values win field by field but the fields it lacks are kept;
 * when it describes a different identity, it replaces the old one wholesale.
 */
export function mergeAuthStatus(previous: AuthStatus | undefined, next: AuthStatus): AuthStatus {
  if (!previous || !sameIdentity(previous, next)) {
    return next;
  }
  const merged: AuthStatus = { ...next };
  if (merged.detail === undefined && previous.detail !== undefined) {
    merged.detail = previous.detail;
  }
  if (previous.account || next.account) {
    merged.account = { ...previous.account, ...next.account };
  }
  if (merged.vendor === undefined && previous.vendor !== undefined) {
    merged.vendor = previous.vendor;
  }
  return merged;
}

/** "Cannot determine" is expressed by absence — an empty response, never an
 *  invented payload. A known logged-out state is still a payload (`kind:
 *  "none"`), which is what distinguishes the two. */
export function authStatusResponse(status: AuthStatus | undefined): AuthStatusResponse {
  if (!status) {
    return {};
  }
  return { _meta: { authStatus: status } };
}

/** `auth/status` takes no params; tolerate missing, null, and `{}`. */
export function parseAuthStatusRequest(params: unknown): AuthStatusRequest {
  if (params === undefined || params === null) {
    return {} as AuthStatusRequest;
  }
  if (typeof params !== "object" || Array.isArray(params)) {
    throw RequestError.invalidParams(undefined, "auth/status params must be an object");
  }
  return {} as AuthStatusRequest;
}
