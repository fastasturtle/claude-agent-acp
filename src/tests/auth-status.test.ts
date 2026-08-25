import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AcpClient, ClaudeAcpAgent as ClaudeAcpAgentType } from "../acp-agent.js";
import { ClaudeAcpAgent } from "../acp-agent.js";
import {
  fromAccountInfo,
  fromCliStatus,
  mergeAuthStatus,
  parseAuthStatusRequest,
  sameIdentity,
} from "../auth-status.js";
import { makeMockQuery } from "./helpers.js";

const mockQuery = vi.hoisted(() => vi.fn());

vi.mock("@anthropic-ai/claude-agent-sdk", async () => ({
  ...(await vi.importActual<typeof import("@anthropic-ai/claude-agent-sdk")>(
    "@anthropic-ai/claude-agent-sdk",
  )),
  query: mockQuery,
}));

/** Shared spy for both `claude auth status --json` and `claude auth logout`.
 *  Tests set `execFileResults` per invoked subcommand. */
const execFileSpy = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFile: execFileSpy };
});

/** CLI outputs verified against the real binary (see the extension spec). */
const CLI_SUBSCRIPTION = JSON.stringify({
  loggedIn: true,
  authMethod: "claude.ai",
  apiProvider: "firstParty",
  email: "user@example.com",
  orgId: "org-1",
  orgName: "ACME",
  subscriptionType: "max",
});
const CLI_API_KEY = JSON.stringify({
  loggedIn: true,
  authMethod: "none",
  apiProvider: "firstParty",
  apiKeySource: "apiKeyHelper",
});
/** An `apiKeyHelper` in settings.json next to a stored claude.ai login: the CLI
 *  reports both identities at once, and the helper key is what actually bills. */
const CLI_KEY_HELPER_AND_SUBSCRIPTION = JSON.stringify({
  loggedIn: true,
  authMethod: "claude.ai",
  apiProvider: "firstParty",
  apiKeySource: "apiKeyHelper",
  email: "user@example.com",
  orgName: "ACME",
  subscriptionType: "max",
});
const CLI_LOGGED_OUT = JSON.stringify({
  loggedIn: false,
  authMethod: "none",
  apiProvider: "firstParty",
});
/** The same login as CLI_SUBSCRIPTION, read from a source that omits the org. */
const CLI_SUBSCRIPTION_NO_ORG = JSON.stringify({
  loggedIn: true,
  authMethod: "claude.ai",
  apiProvider: "firstParty",
  email: "user@example.com",
  subscriptionType: "max",
});
/** A different person logged in since the last read. */
const CLI_OTHER_ACCOUNT = JSON.stringify({
  loggedIn: true,
  authMethod: "claude.ai",
  apiProvider: "firstParty",
  email: "other@example.com",
  subscriptionType: "pro",
});
/** A 3P backend: no claude.ai login, yet the agent is authenticated through
 *  credentials it does not own (AWS). `loggedIn` is false here. */
const CLI_BEDROCK = JSON.stringify({
  loggedIn: false,
  authMethod: "none",
  apiProvider: "bedrock",
});

const MOCK_MODELS = [
  { value: "id", displayName: "name", description: "description", supportsAutoMode: true },
];

describe("auth status mappers", () => {
  it("maps a first-party subscription account", () => {
    expect(
      fromAccountInfo({
        apiProvider: "firstParty",
        subscriptionType: "max",
        email: "user@example.com",
        organization: "ACME",
      }),
    ).toEqual({
      kind: "account",
      label: "Claude Max",
      account: { plan: "max", email: "user@example.com", organization: "ACME" },
    });
  });

  it("maps an API key source", () => {
    expect(
      fromAccountInfo({ apiProvider: "firstParty", apiKeySource: "ANTHROPIC_API_KEY" }),
    ).toEqual({
      kind: "api_key",
      label: "Anthropic API key",
      detail: "ANTHROPIC_API_KEY",
    });
  });

  it("prefers the API key over a stored subscription when both are reported", () => {
    // Claude Code's authentication precedence ranks an apiKeyHelper key above
    // the `/login` subscription, so the key is the identity that pays.
    expect(fromCliStatus(CLI_KEY_HELPER_AND_SUBSCRIPTION)).toEqual({
      kind: "api_key",
      label: "Anthropic API key",
      detail: "apiKeyHelper",
    });
    expect(
      fromAccountInfo({
        apiProvider: "firstParty",
        apiKeySource: "apiKeyHelper",
        subscriptionType: "max",
        email: "user@example.com",
        organization: "ACME",
      }),
    ).toEqual({
      kind: "api_key",
      label: "Anthropic API key",
      detail: "apiKeyHelper",
    });
  });

  it("maps third-party backends to external auth", () => {
    expect(fromAccountInfo({ apiProvider: "bedrock" })).toEqual({
      kind: "external",
      label: "AWS Bedrock",
    });
    expect(fromAccountInfo({ apiProvider: "vertex" })).toEqual({
      kind: "external",
      label: "Google Vertex AI",
    });
  });

  it("maps the gateway backend", () => {
    expect(fromAccountInfo({ apiProvider: "gateway" })).toEqual({
      kind: "gateway",
      label: "Custom model gateway",
    });
  });

  it("reports an account with no identity signal as no information", () => {
    // The SDK always fills apiProvider; under an apiKeyHelper that is all a
    // session account carries. Mapping it to `none` would claim "logged out".
    expect(fromAccountInfo({ apiProvider: "firstParty" })).toBeUndefined();
    expect(fromAccountInfo({})).toBeUndefined();
    expect(fromAccountInfo(undefined)).toBeUndefined();
    // `tokenSource` names the OAuth token's origin, never a key source.
    expect(
      fromAccountInfo({ apiProvider: "firstParty", tokenSource: "CLAUDE_CODE_OAUTH_TOKEN" }),
    ).toBeUndefined();
  });

  it("maps CLI probe output", () => {
    expect(fromCliStatus(CLI_SUBSCRIPTION)).toEqual({
      kind: "account",
      label: "Claude Max",
      account: { plan: "max", email: "user@example.com", organization: "ACME" },
    });
    expect(fromCliStatus(CLI_API_KEY)).toEqual({
      kind: "api_key",
      label: "Anthropic API key",
      detail: "apiKeyHelper",
    });
    expect(fromCliStatus(CLI_LOGGED_OUT)).toEqual({
      kind: "none",
      label: "Not logged in",
    });
  });

  it("lets a third-party backend outrank the logged-out flag", () => {
    // `loggedIn` tracks the claude.ai login only; on Bedrock the credentials
    // are external and the agent is authenticated all the same.
    expect(fromCliStatus(CLI_BEDROCK)).toEqual({ kind: "external", label: "AWS Bedrock" });
  });

  it("reports unparseable CLI output as not known", () => {
    expect(fromCliStatus("")).toBeUndefined();
    expect(fromCliStatus("Usage: claude auth status")).toBeUndefined();
    expect(fromCliStatus("[]")).toBeUndefined();
    expect(fromCliStatus('{"foo": 1}')).toBeUndefined();
  });

  it("merges a poorer read into the same identity and replaces a different one", () => {
    const stored = {
      kind: "account" as const,
      label: "Claude Max",
      account: { plan: "max", email: "user@example.com", organization: "ACME" },
    };
    // Same login, read from a source without the organization: it survives.
    expect(
      mergeAuthStatus(stored, {
        kind: "account",
        label: "Claude Max",
        account: { plan: "max", email: "user@example.com" },
      }),
    ).toEqual(stored);
    // A different login replaces everything, organization included.
    expect(
      mergeAuthStatus(stored, {
        kind: "account",
        label: "Claude Pro",
        account: { plan: "pro", email: "other@example.com" },
      }),
    ).toEqual({
      kind: "account",
      label: "Claude Pro",
      account: { plan: "pro", email: "other@example.com" },
    });
    // A different kind never merges, even when it looks adjacent.
    expect(
      mergeAuthStatus(stored, { kind: "api_key", label: "Anthropic API key", detail: "env" }),
    ).toEqual({ kind: "api_key", label: "Anthropic API key", detail: "env" });
    // Key sources identify api_key payloads.
    expect(
      sameIdentity(
        { kind: "api_key", label: "Anthropic API key", detail: "apiKeyHelper" },
        { kind: "api_key", label: "Anthropic API key", detail: "env" },
      ),
    ).toBe(false);
  });

  it("accepts the empty params of auth/status", () => {
    expect(parseAuthStatusRequest(undefined)).toEqual({});
    expect(parseAuthStatusRequest(null)).toEqual({});
    expect(parseAuthStatusRequest({})).toEqual({});
    expect(() => parseAuthStatusRequest("nope")).toThrow();
  });
});

describe("auth status over ACP", () => {
  let agent: ClaudeAcpAgentType;
  let extNotification: ReturnType<typeof vi.fn>;
  /** stdout the fake `claude auth status --json` prints, and whether the exec
   *  fails (the logged-out case exits 1 with JSON still on stdout). */
  let statusStdout: string;
  let statusFails: boolean;
  /** While true, probes hang until `flushStatus()` releases them, so a test can
   *  interleave an `authenticate`/`logout` with a probe that is still running.
   *  Each probe captures the output configured when it was spawned. */
  let deferStatus: boolean;
  let pendingStatus: Array<() => void>;

  /** Let every already-scheduled promise chain run to completion. */
  function settle() {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  /** Release one pending probe by spawn order, so a test can decide which of
   *  two in-flight reads lands first. */
  async function releaseStatus(index: number) {
    const [release] = pendingStatus.splice(index, 1);
    release();
    await settle();
  }

  /** Release the probes spawned so far and let their promises settle, repeating
   *  so a probe spawned by that settling (e.g. logout's fresh read) is released
   *  too. */
  async function flushStatus(rounds = 3) {
    for (let round = 0; round < rounds; round++) {
      const pending = pendingStatus;
      pendingStatus = [];
      for (const release of pending) release();
      await settle();
    }
  }

  beforeEach(() => {
    // Skip native-binary resolution; the exec itself is mocked.
    process.env.CLAUDE_CODE_EXECUTABLE = "claude";
    statusStdout = CLI_SUBSCRIPTION;
    statusFails = false;
    deferStatus = false;
    pendingStatus = [];
    execFileSpy.mockImplementation(
      (_file: string, args: string[], cb: (...a: unknown[]) => void) => {
        if (args[1] === "status") {
          const stdout = statusStdout;
          const fails = statusFails;
          const answer = () => {
            if (fails) {
              cb(Object.assign(new Error("exit 1"), { stdout, stderr: "" }));
            } else {
              cb(null, { stdout, stderr: "" });
            }
          };
          if (deferStatus) {
            pendingStatus.push(answer);
          } else {
            answer();
          }
          return;
        }
        cb(null, { stdout: "", stderr: "" });
      },
    );
    mockQuery.mockImplementation(() => makeMockQuery());
    extNotification = vi.fn().mockResolvedValue(undefined);
    agent = new ClaudeAcpAgent({
      sessionUpdate: async () => {},
      extNotification,
    } as unknown as AcpClient);
  });

  afterEach(() => {
    delete process.env.CLAUDE_CODE_EXECUTABLE;
    vi.resetAllMocks();
  });

  function statusCalls() {
    return execFileSpy.mock.calls.filter((call) => (call[1] as string[])[1] === "status");
  }

  function updates() {
    return extNotification.mock.calls.filter((call) => call[0] === "auth/status_update");
  }

  it("answers auth/status from the CLI probe", async () => {
    const response = await agent.authStatus({});
    expect(response).toEqual({
      _meta: {
        authStatus: {
          kind: "account",
          label: "Claude Max",
          account: { plan: "max", email: "user@example.com", organization: "ACME" },
        },
      },
    });
  });

  it("reports the logged-out CLI verdict even though the probe exits non-zero", async () => {
    statusStdout = CLI_LOGGED_OUT;
    statusFails = true;
    const response = await agent.authStatus({});
    expect(response).toEqual({
      _meta: { authStatus: { kind: "none", label: "Not logged in" } },
    });
  });

  it("reports nothing when the probe cannot be read", async () => {
    statusStdout = "";
    statusFails = true;
    const response = await agent.authStatus({});
    // "Cannot determine" is absence: no payload at all. A known logged-out
    // state would still answer with one, of kind "none".
    expect(response).toEqual({});
    expect(updates()).toHaveLength(0);
  });

  it("advertises the extension in agentCapabilities._meta", async () => {
    const response = await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    // Presence is the whole advertisement: the marker stays empty, and a
    // status payload there would violate the contract.
    expect(response.agentCapabilities?._meta?.authStatus).toEqual({});
    // The marker lives in agentCapabilities only — never at the top level.
    expect(response._meta?.authStatus).toBeUndefined();
  });

  it("shares one probe between initialize and a concurrent auth/status", async () => {
    const [, response] = await Promise.all([
      agent.initialize({ protocolVersion: 1, clientCapabilities: {} }),
      agent.authStatus({}),
    ]);
    expect(statusCalls()).toHaveLength(1);
    expect(response._meta?.authStatus?.kind).toBe("account");
    // No snapshot rides in the initialize response — only the notification.
    expect(updates()).toHaveLength(1);
  });

  it("re-probes on every pull, so an external logout is seen", async () => {
    // The pull is the client's "re-check now": a logout performed in another
    // terminal must show up without waiting for a session create.
    const first = await agent.authStatus({});
    expect(first._meta?.authStatus).toEqual({
      kind: "account",
      label: "Claude Max",
      account: { plan: "max", email: "user@example.com", organization: "ACME" },
    });

    statusStdout = CLI_LOGGED_OUT;
    statusFails = true;
    const second = await agent.authStatus({});

    expect(statusCalls()).toHaveLength(2);
    expect(second).toEqual({
      _meta: { authStatus: { kind: "none", label: "Not logged in" } },
    });
    // The change reaches clients that never pull again, too.
    expect(updates().at(-1)?.[1]).toEqual({
      authStatus: { kind: "none", label: "Not logged in" },
    });
  });

  it("shares one exec between concurrent pulls", async () => {
    const [a, b] = await Promise.all([agent.authStatus({}), agent.authStatus({})]);
    expect(statusCalls()).toHaveLength(1);
    expect(a).toEqual(b);
  });

  it("keeps richer stored fields when a poorer probe reports the same identity", async () => {
    // The session AccountInfo knows the organization; the CLI probe here does
    // not. Re-reading the same login must not regress the payload.
    mockQuery.mockImplementation(() =>
      makeMockQuery({
        initializationResult: async () => ({
          models: MOCK_MODELS,
          account: {
            apiProvider: "firstParty",
            subscriptionType: "max",
            email: "user@example.com",
            organization: "ACME",
          },
        }),
      }),
    );
    await agent.newSession({ cwd: process.cwd(), mcpServers: [] });

    statusStdout = CLI_SUBSCRIPTION_NO_ORG;
    const response = await agent.authStatus({});

    expect(response._meta?.authStatus).toEqual({
      kind: "account",
      label: "Claude Max",
      account: { plan: "max", email: "user@example.com", organization: "ACME" },
    });
  });

  it("lets a probe of a different identity replace the stored one wholesale", async () => {
    mockQuery.mockImplementation(() =>
      makeMockQuery({
        initializationResult: async () => ({
          models: MOCK_MODELS,
          account: {
            apiProvider: "firstParty",
            subscriptionType: "max",
            email: "user@example.com",
            organization: "ACME",
          },
        }),
      }),
    );
    await agent.newSession({ cwd: process.cwd(), mcpServers: [] });

    // Someone logged in as another user in a terminal: no field survives.
    statusStdout = CLI_OTHER_ACCOUNT;
    const response = await agent.authStatus({});

    expect(response._meta?.authStatus).toEqual({
      kind: "account",
      label: "Claude Pro",
      account: { plan: "pro", email: "other@example.com" },
    });
  });

  it("pushes auth/status_update when the initialize probe resolves", async () => {
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    await vi.waitFor(() => expect(updates()).toHaveLength(1));
    expect(updates()).toEqual([
      [
        "auth/status_update",
        {
          authStatus: {
            kind: "account",
            label: "Claude Max",
            account: { plan: "max", email: "user@example.com", organization: "ACME" },
          },
        },
      ],
    ]);
  });

  it("upgrades the identity from AccountInfo on session create", async () => {
    statusStdout = CLI_API_KEY;
    await agent.authStatus({});
    mockQuery.mockImplementation(() =>
      makeMockQuery({
        initializationResult: async () => ({
          models: MOCK_MODELS,
          account: { apiProvider: "firstParty", subscriptionType: "pro", email: "u@x.com" },
        }),
      }),
    );

    await agent.newSession({ cwd: process.cwd(), mcpServers: [] });

    expect(updates().map((call) => call[1])).toEqual([
      {
        authStatus: {
          kind: "api_key",
          label: "Anthropic API key",
          detail: "apiKeyHelper",
        },
      },
      {
        authStatus: {
          kind: "account",
          label: "Claude Pro",
          account: { plan: "pro", email: "u@x.com" },
        },
      },
    ]);
  });

  it.each([
    ["only apiProvider", { apiProvider: "firstParty" }],
    ["an empty object", {}],
  ])("keeps the probed API key when the session account carries %s", async (_name, account) => {
    // Regression: an apiKeyHelper setup yields a truthy but empty account, and
    // mapping it to `none` used to overwrite the correct api_key status ~0.5 s
    // after connect.
    statusStdout = CLI_API_KEY;
    await agent.authStatus({});
    expect(updates()).toHaveLength(1);

    mockQuery.mockImplementation(() =>
      makeMockQuery({
        initializationResult: async () => ({ models: MOCK_MODELS, account }),
      }),
    );
    await agent.newSession({ cwd: process.cwd(), mcpServers: [] });

    expect(updates()).toHaveLength(1);
    expect((await agent.authStatus({}))._meta?.authStatus).toEqual({
      kind: "api_key",
      label: "Anthropic API key",
      detail: "apiKeyHelper",
    });
  });

  it("ignores the session account while a client provider override is active", async () => {
    // `providers/set` routing is the client's, not the agent's login: the
    // session then reports `apiProvider: "gateway"`, which must stay invisible
    // to authStatus. The CLI probe keeps describing the agent-owned store.
    statusStdout = CLI_API_KEY;
    await agent.authStatus({});
    expect(updates()).toHaveLength(1);

    await agent.unstable_setProvider({
      providerId: "main",
      apiType: "anthropic",
      baseUrl: "https://client-gateway.example/v1",
      headers: {},
    });
    mockQuery.mockImplementation(() =>
      makeMockQuery({
        initializationResult: async () => ({
          models: MOCK_MODELS,
          account: { apiProvider: "gateway" },
        }),
      }),
    );
    await agent.newSession({ cwd: process.cwd(), mcpServers: [] });

    expect(updates()).toHaveLength(1);
    expect((await agent.authStatus({}))._meta?.authStatus).toEqual({
      kind: "api_key",
      label: "Anthropic API key",
      detail: "apiKeyHelper",
    });
  });

  it("still probes the agent's own login under a client provider override", async () => {
    await agent.unstable_setProvider({
      providerId: "main",
      apiType: "anthropic",
      baseUrl: "https://client-gateway.example/v1",
      headers: {},
    });

    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    await agent.authStatus({});

    expect(statusCalls()).toHaveLength(1);
    expect(updates()).toHaveLength(1);
  });

  it("re-publishes an unchanged identity instead of suppressing it", async () => {
    // Clients replace their whole state per update and tolerate duplicates, so
    // the agent keeps no comparison of its own.
    const authStatus = {
      kind: "account",
      label: "Claude Max",
      account: { plan: "max", email: "user@example.com" },
    };
    mockQuery.mockImplementation(() =>
      makeMockQuery({
        initializationResult: async () => ({
          models: MOCK_MODELS,
          account: {
            apiProvider: "firstParty",
            subscriptionType: "max",
            email: "user@example.com",
          },
        }),
      }),
    );

    await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
    await agent.newSession({ cwd: process.cwd(), mcpServers: [] });

    expect(updates().map((call) => call[1])).toEqual([{ authStatus }, { authStatus }]);
  });

  it("reports the gateway identity after gateway authentication", async () => {
    await agent.authenticate({
      methodId: "gateway",
      _meta: { gateway: { baseUrl: "https://gw.example.com/v1", headers: {} } },
    } as never);

    expect(updates().map((call) => call[1])).toEqual([
      {
        authStatus: {
          kind: "gateway",
          label: "Custom model gateway",
          detail: "gw.example.com",
        },
      },
    ]);
  });

  it("discards a probe that a gateway authenticate overtook", async () => {
    // The initialize-time probe is slower than the login: releasing it after
    // `authenticate` must not repaint the gateway identity with the CLI store's.
    deferStatus = true;
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const pull = agent.authStatus({});

    await agent.authenticate({
      methodId: "gateway",
      _meta: { gateway: { baseUrl: "https://gw.example.com/v1", headers: {} } },
    } as never);
    await flushStatus();

    const gateway = {
      kind: "gateway",
      label: "Custom model gateway",
      detail: "gw.example.com",
    };
    expect(updates().map((call) => call[1])).toEqual([{ authStatus: gateway }]);
    // The pull that was waiting on the overtaken probe answers with the newer
    // state, not with the discarded read.
    expect((await pull)._meta?.authStatus).toEqual(gateway);
    expect((await agent.authStatus({}))._meta?.authStatus).toEqual(gateway);
  });

  it("ignores a pre-logout probe and answers from a fresh one", async () => {
    // A probe started before `logout` still describes the logged-in world: it
    // must neither be reused by logout nor be published when it lands.
    deferStatus = true;
    const pull = agent.authStatus({});
    statusStdout = CLI_LOGGED_OUT;
    statusFails = true;

    const logout = agent.logout({});
    await flushStatus();
    await logout;
    await pull;

    // At least two reads: the stale one, plus the fresh one logout started
    // itself instead of joining it.
    expect(statusCalls().length).toBeGreaterThanOrEqual(2);
    // The logged-in identity the stale probe carried was never published.
    expect(updates().map((call) => call[1])).toEqual([
      { authStatus: { kind: "none", label: "Not logged in" } },
    ]);
    deferStatus = false;
    expect((await agent.authStatus({}))._meta?.authStatus).toEqual({
      kind: "none",
      label: "Not logged in",
    });
  });

  it("answers a pull from the post-logout read once that read has been pushed", async () => {
    // The pull joined a probe that a logout invalidated. Because the logout's
    // own read lands — and is pushed — before the pull answers, the answer must
    // be that pushed state: the response may never regress behind it.
    deferStatus = true;
    const seed = agent.authStatus({});
    await flushStatus();
    await seed;
    expect(agent.currentAuthStatus?.kind).toBe("account");

    // A pull joins a probe that still describes the logged-in world...
    const pull = agent.authStatus({});
    // ...then the user logs out (in the IDE or a terminal): epoch bump plus a
    // fresh read of its own.
    statusStdout = CLI_LOGGED_OUT;
    statusFails = true;
    const logout = agent.logout({});
    await vi.waitFor(() => expect(pendingStatus).toHaveLength(2));

    // The logout's read lands first and pushes "logged out"; the pre-logout
    // read lands after and is discarded, publishing nothing.
    await releaseStatus(1);
    expect(updates().at(-1)?.[1]).toEqual({
      authStatus: { kind: "none", label: "Not logged in" },
    });
    await releaseStatus(0);
    await logout;

    expect((await pull)._meta?.authStatus).toEqual({ kind: "none", label: "Not logged in" });
    expect(updates().at(-1)?.[1]).toEqual({
      authStatus: { kind: "none", label: "Not logged in" },
    });
  });

  it("never answers behind an update already pushed", async () => {
    // Another publisher (a session create, say) lands between the read's own
    // push and the response. The client already holds that newer push, so the
    // answer is it — not the value the read carried.
    const published = { kind: "api_key" as const, label: "Anthropic API key", detail: "env" };
    extNotification.mockImplementation(async (method: string, params: unknown) => {
      const sent = (params as { authStatus?: { kind?: string } }).authStatus;
      if (method === "auth/status_update" && sent?.kind === "account") {
        agent.setAuthStatus(published);
      }
    });

    const response = await agent.authStatus({});

    expect(response._meta?.authStatus).toEqual(published);
    expect(
      updates().map((call) => (call[1] as { authStatus: { kind: string } }).authStatus.kind),
    ).toEqual(["account", "api_key"]);
  });

  it("answers a readable-but-empty probe from the last known state", async () => {
    // The CLI cannot be read at all, yet a session already told us who we are:
    // report that rather than pretending the state is unknown.
    const published = { kind: "api_key" as const, label: "Anthropic API key", detail: "env" };
    agent.setAuthStatus(published);
    statusStdout = "";
    statusFails = true;

    expect((await agent.authStatus({}))._meta?.authStatus).toEqual(published);
  });

  it("drops a stale identity when the post-logout probe is unreadable", async () => {
    await agent.authStatus({});
    statusStdout = "";
    statusFails = true;

    await agent.logout({});

    expect(updates().at(-1)?.[1]).toEqual({
      authStatus: { kind: "none", label: "Not logged in" },
    });
  });

  it("re-probes after logout and reports the resulting state", async () => {
    await agent.authStatus({});
    statusStdout = CLI_LOGGED_OUT;
    statusFails = true;

    await agent.logout({});

    expect(statusCalls()).toHaveLength(2);
    expect(updates().at(-1)?.[1]).toEqual({
      authStatus: { kind: "none", label: "Not logged in" },
    });
  });
});
