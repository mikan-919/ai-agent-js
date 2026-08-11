import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { resolveSandboxPath } from "./sandboxTools";

describe("resolveSandboxPath", () => {
  const cwd = "/home/user/app-state/sandboxes/acme-demo/feature-x";

  test("resolves a relative path inside the sandbox", () => {
    expect(resolveSandboxPath(cwd, "src/index.ts")).toBe(join(cwd, "src/index.ts"));
  });

  test("resolves '.' to the sandbox root", () => {
    expect(resolveSandboxPath(cwd, ".")).toBe(cwd);
  });

  test("rejects a path that escapes the sandbox via '..'", () => {
    expect(() => resolveSandboxPath(cwd, "../../etc/passwd")).toThrow("escapes the sandbox");
  });

  test("rejects an absolute path outside the sandbox", () => {
    expect(() => resolveSandboxPath(cwd, "/etc/passwd")).toThrow("escapes the sandbox");
  });

  test("allows an absolute path that happens to be the sandbox itself", () => {
    expect(resolveSandboxPath(cwd, join(cwd, "src/index.ts"))).toBe(join(cwd, "src/index.ts"));
  });
});
