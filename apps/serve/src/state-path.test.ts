import { expect, test } from "bun:test";

import { resolveStatePath } from "./state-path";

test("an explicitly configured state path takes priority", () => {
  const directories: string[] = [];

  expect(
    resolveStatePath({
      explicitPath: "/var/lib/oriel/custom.sqlite",
      xdgDataHome: "/xdg/data",
      homeDirectory: "/home/tester",
      ensureDirectory: (directory) => directories.push(directory),
    }),
  ).toBe("/var/lib/oriel/custom.sqlite");
  expect(directories).toEqual(["/var/lib/oriel"]);
});

test("the XDG data home is used for the default state path", () => {
  const directories: string[] = [];

  expect(
    resolveStatePath({
      xdgDataHome: "/xdg/data",
      homeDirectory: "/home/tester",
      ensureDirectory: (directory) => directories.push(directory),
    }),
  ).toBe("/xdg/data/oriel/state.sqlite");
  expect(directories).toEqual(["/xdg/data/oriel"]);
});

test("the default state path uses the user's local data directory", () => {
  const directories: string[] = [];

  expect(
    resolveStatePath({
      homeDirectory: "/home/tester",
      ensureDirectory: (directory) => directories.push(directory),
    }),
  ).toBe("/home/tester/.local/share/oriel/state.sqlite");
  expect(directories).toEqual(["/home/tester/.local/share/oriel"]);
});
