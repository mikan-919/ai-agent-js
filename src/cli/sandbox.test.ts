import { describe, expect, test } from "bun:test";
import { parseSandboxArgs } from "./sandbox";

describe("parseSandboxArgs", () => {
  test("defaults to the worktree backend with no flags", () => {
    const args = parseSandboxArgs(["feature/x"]);
    expect(args).toEqual({ branch: "feature/x", backend: "worktree", force: false, json: false });
  });

  test("parses --backend, --force, and --json", () => {
    const args = parseSandboxArgs(["feature/x", "--backend", "docker", "--force", "--json"]);
    expect(args).toEqual({ branch: "feature/x", backend: "docker", force: true, json: true });
  });

  test("throws when branch is missing", () => {
    expect(() => parseSandboxArgs([])).toThrow("branch is required");
  });

  test("throws on an invalid --backend value", () => {
    expect(() => parseSandboxArgs(["feature/x", "--backend", "bogus"])).toThrow(
      "--backend must be 'worktree' or 'docker'",
    );
  });

  test("throws on an unknown flag", () => {
    expect(() => parseSandboxArgs(["feature/x", "--nope"])).toThrow("unknown flag '--nope'");
  });
});
