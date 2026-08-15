import { describe, expect, it } from "vitest";

import {
  minimalInstallationTokenPermissions,
  parseInstallationTokenPermissions,
} from "./installation-token-permissions";

describe("installation token permissions", () => {
  it("keeps only the permissions the product needs", () => {
    expect(minimalInstallationTokenPermissions).toEqual({
      contents: "write",
      issues: "write",
      pull_requests: "write",
      metadata: "read",
    });
  });

  it("accepts a configured subset that is not wider than the allowlist", () => {
    expect(
      parseInstallationTokenPermissions(
        JSON.stringify({ issues: "write", contents: "read", metadata: "read" }),
      ),
    ).toEqual({ issues: "write", contents: "read", metadata: "read" });
  });

  it("refuses permissions outside the allowlist", () => {
    expect(() =>
      parseInstallationTokenPermissions(
        JSON.stringify({ issues: "write", administration: "write" }),
      ),
    ).toThrow();
    expect(() =>
      parseInstallationTokenPermissions(
        JSON.stringify({
          members: "read",
          organization_administration: "read",
        }),
      ),
    ).toThrow();
  });

  it("refuses values wider than the allowlisted maximum", () => {
    expect(() =>
      parseInstallationTokenPermissions(JSON.stringify({ issues: "admin" })),
    ).toThrow();
    // metadataはreadだけを許す。
    expect(() =>
      parseInstallationTokenPermissions(JSON.stringify({ metadata: "write" })),
    ).toThrow();
  });

  it("refuses input that is not an object of string values", () => {
    expect(() => parseInstallationTokenPermissions("")).toThrow();
    expect(() => parseInstallationTokenPermissions("null")).toThrow();
    expect(() => parseInstallationTokenPermissions("[]")).toThrow();
    expect(() => parseInstallationTokenPermissions("{}")).toThrow();
    expect(() =>
      parseInstallationTokenPermissions(JSON.stringify({ issues: 1 })),
    ).toThrow();
    expect(() =>
      parseInstallationTokenPermissions('{"__proto__":{"issues":"write"}}'),
    ).toThrow();
  });
});
