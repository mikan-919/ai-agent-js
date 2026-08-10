import { describe, expect, test } from "bun:test";
import { detectDocsDrift } from "./docs";
import type { GitDiffFileStat } from "./types";

function fileStat(path: string): GitDiffFileStat {
  return { path, insertions: 1, deletions: 1, binary: false };
}

describe("detectDocsDrift", () => {
  test("returns nothing when the branch/main diff has no watched docs", () => {
    expect(detectDocsDrift([fileStat("src/index.ts")])).toEqual([]);
  });

  test("flags CONCEPT.md and ROADMAP.md when they appear in the diff", () => {
    const drift = detectDocsDrift([fileStat("src/index.ts"), fileStat("ROADMAP.md"), fileStat("CONCEPT.md")]);
    expect(drift).toEqual(["CONCEPT.md", "ROADMAP.md"]);
  });

  test("ignores FEATURE.md and HANDOFF.md — not watched for drift", () => {
    expect(detectDocsDrift([fileStat("FEATURE.md"), fileStat("HANDOFF.md")])).toEqual([]);
  });

  test("returns nothing for an empty diff", () => {
    expect(detectDocsDrift([])).toEqual([]);
  });
});
