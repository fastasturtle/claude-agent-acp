import { describe, expect, it } from "vitest";
import type { PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import { normalizeDurablePermissionChangeSet } from "../permission-normalization.js";
import { buildClaudePermissionOptions, PERMISSION_OPTION_ID } from "../permission-options.js";
import { buildClaudePermissionPresentation } from "../permission-presentation.js";
import { mapClaudePermissionResponse } from "../permission-response.js";

const rule = { toolName: "Bash", ruleContent: "npm test:*" };

describe("Claude permission suggestion normalization", () => {
  it.each([undefined, [], null, "bad"])("omits a durable choice for %j", (suggestions) => {
    expect(normalizeDurablePermissionChangeSet(suggestions)).toBeUndefined();
  });

  it.each(["addRules", "replaceRules", "removeRules"] as const)(
    "supports %s without changing the provider payload",
    (type) => {
      const suggestions: PermissionUpdate[] = [
        { type, rules: [rule], behavior: "allow", destination: "session" },
      ];
      const normalized = normalizeDurablePermissionChangeSet(suggestions);
      expect(normalized?.updates).toBe(suggestions);
      expect(normalized?.description).toContain("current Claude session");
    },
  );

  it.each(["allow", "deny", "ask"] as const)("describes %s rule behavior", (behavior) => {
    const normalized = normalizeDurablePermissionChangeSet([
      { type: "addRules", rules: [rule], behavior, destination: "session" },
    ]);
    expect(normalized?.description).toMatch(
      behavior === "allow" ? /^Allow / : behavior === "deny" ? /^Deny / : /^Ask before /,
    );
  });

  it.each([
    ["session", "current Claude session"],
    ["cliArg", "Claude process"],
    ["userSettings", "user settings"],
    ["projectSettings", "shared project settings"],
    ["localSettings", "local-project settings"],
  ] as const)("describes destination %s", (destination, phrase) => {
    const normalized = normalizeDurablePermissionChangeSet([
      { type: "addDirectories", directories: ["/work"], destination },
    ]);
    expect(normalized?.description).toContain(phrase);
  });

  it.each(["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"] as const)(
    "supports setMode %s",
    (mode) => {
      const normalized = normalizeDurablePermissionChangeSet([
        { type: "setMode", mode, destination: "session" },
      ]);
      expect(normalized?.description).toBe(
        `Set Claude permission mode to ${mode} for the current Claude session.`,
      );
    },
  );

  it.each(["addDirectories", "removeDirectories"] as const)("supports %s", (type) => {
    const normalized = normalizeDurablePermissionChangeSet([
      { type, directories: ["/one", "/two"], destination: "localSettings" },
    ]);
    expect(normalized?.description).toContain("/one, /two");
  });

  it.each([
    [{ type: "future", destination: "session" }],
    [{ type: "setMode", mode: "future", destination: "session" }],
    [{ type: "addRules", rules: [rule], behavior: "future", destination: "session" }],
    [{ type: "addDirectories", directories: ["/work"], destination: "future" }],
    [{ type: "addDirectories", directories: [], destination: "session" }],
  ])("fails closed for an unknown or invalid change set", (suggestions) => {
    expect(normalizeDurablePermissionChangeSet(suggestions)).toBeUndefined();
  });

  it("suppresses every durable option for a forced ask", () => {
    expect(
      normalizeDurablePermissionChangeSet(
        [{ type: "addDirectories", directories: ["/work"], destination: "projectSettings" }],
        true,
      ),
    ).toBeUndefined();
  });
});

describe("Claude permission ACP v1 presentation", () => {
  it("keeps command input separate from compact permission wording", () => {
    const input = { command: "npm test", description: "Run the tests" };
    const presentation = buildClaudePermissionPresentation({
      toolName: "Bash",
      input,
      toolUseID: "tool-1",
      displayName: "Run command",
      description: "Needed to verify the change.",
    });
    expect(presentation._meta).toEqual({
      permission: {
        version: 1,
        title: "Run command",
        description: "Needed to verify the change.",
      },
    });
    expect(presentation.toolCall).toMatchObject({
      toolCallId: "tool-1",
      name: "Bash",
      kind: "execute",
      status: "pending",
      rawInput: input,
    });
    expect(presentation.toolCall.rawInput).toBe(input);
    expect(JSON.stringify(presentation._meta)).not.toContain("npm test");
  });

  it("uses provider title and decisionReason without rewriting them", () => {
    expect(
      buildClaudePermissionPresentation({
        toolName: "Read",
        input: { file_path: "/work/a.ts" },
        toolUseID: "tool-2",
        title: "Claude wants to read /work/a.ts",
        decisionReason: "Required by the project policy.",
      })._meta,
    ).toMatchObject({
      permission: {
        title: "Claude wants to read /work/a.ts",
        description: "Required by the project policy.",
      },
    });
    expect(
      buildClaudePermissionPresentation({
        toolName: "Read",
        input: {},
        toolUseID: "tool-3",
        decisionReason: "internal_policy_code",
      })._meta,
    ).toBeUndefined();
  });

  it("adds a non-duplicated blocked path to standard locations", () => {
    const presentation = buildClaudePermissionPresentation({
      toolName: "Read",
      input: { file_path: "/work/a.ts" },
      toolUseID: "tool-4",
      blockedPath: "/outside/b.ts",
    });
    expect(presentation.toolCall.locations).toEqual([
      { path: "/work/a.ts", line: 1 },
      { path: "/outside/b.ts" },
    ]);
  });

  it("omits permission metadata when the provider supplied no title", () => {
    const presentation = buildClaudePermissionPresentation({
      toolName: "mcp__demo__deploy",
      input: { target: "staging" },
      toolUseID: "tool-5",
    });
    expect(presentation.toolCall).toMatchObject({ kind: "other", name: "mcp__demo__deploy" });
    expect(presentation._meta).toBeUndefined();
  });
});

describe("Claude permission options and response mapping", () => {
  it("offers allow-once, at most one exact durable choice, then reject", () => {
    const changeSet = normalizeDurablePermissionChangeSet([
      { type: "addRules", rules: [rule], behavior: "allow", destination: "session" },
      { type: "addDirectories", directories: ["/work"], destination: "session" },
    ]);
    expect(buildClaudePermissionOptions(changeSet)).toEqual([
      { optionId: PERMISSION_OPTION_ID.allowOnce, name: "Allow once", kind: "allow_once" },
      {
        optionId: PERMISSION_OPTION_ID.allowWithUpdates,
        name: "Allow and update permissions",
        kind: "allow_always",
        _meta: {
          permission: {
            version: 1,
            description:
              "Allow Bash calls matching “npm test:*” for the current Claude session. Add filesystem access to /work for the current Claude session.",
          },
        },
      },
      { optionId: PERMISSION_OPTION_ID.reject, name: "Reject", kind: "reject_once" },
    ]);
  });

  it("maps one-time allow without remembered updates", () => {
    expect(
      mapClaudePermissionResponse(
        { outcome: { outcome: "selected", optionId: PERMISSION_OPTION_ID.allowOnce } },
        { command: "pwd" },
        "tool-1",
      ),
    ).toEqual({
      behavior: "allow",
      updatedInput: { command: "pwd" },
      toolUseID: "tool-1",
      decisionClassification: "user_temporary",
    });
  });

  it("maps durable allow to the exact provider array", () => {
    const suggestions: PermissionUpdate[] = [
      { type: "addRules", rules: [rule], behavior: "allow", destination: "session" },
    ];
    const changeSet = normalizeDurablePermissionChangeSet(suggestions);
    const result = mapClaudePermissionResponse(
      { outcome: { outcome: "selected", optionId: PERMISSION_OPTION_ID.allowWithUpdates } },
      { command: "npm test" },
      "tool-2",
      changeSet,
    );
    expect(result).toMatchObject({
      behavior: "allow",
      toolUseID: "tool-2",
      decisionClassification: "user_permanent",
    });
    expect(result.behavior === "allow" && result.updatedPermissions).toBe(suggestions);
  });

  it("distinguishes explicit reject from cancellation", () => {
    expect(
      mapClaudePermissionResponse(
        { outcome: { outcome: "selected", optionId: PERMISSION_OPTION_ID.reject } },
        {},
        "tool-3",
      ),
    ).toEqual({
      behavior: "deny",
      message: "User refused permission to run tool",
      toolUseID: "tool-3",
      decisionClassification: "user_reject",
    });
    expect(() =>
      mapClaudePermissionResponse({ outcome: { outcome: "cancelled" } }, {}, "tool-3"),
    ).toThrow("Tool use aborted");
  });

  it("fails closed for an unavailable or unknown selection", () => {
    expect(() =>
      mapClaudePermissionResponse(
        { outcome: { outcome: "selected", optionId: PERMISSION_OPTION_ID.allowWithUpdates } },
        {},
        "tool-4",
      ),
    ).toThrow("Invalid durable permission selection");
    expect(() =>
      mapClaudePermissionResponse(
        { outcome: { outcome: "selected", optionId: "future" } },
        {},
        "tool-4",
      ),
    ).toThrow("Unknown permission option");
  });
});
