import { describe, expect, test } from "bun:test";
import type { WorkContext } from "../context";
import { buildSystemPrompt } from "./systemPrompt";

function baseContext(overrides: Partial<WorkContext> = {}): WorkContext {
  return {
    git: {
      branch: "feature/x",
      mainBranch: "main",
      diff: { files: [], filesChanged: 0, insertions: 0, deletions: 0 },
    },
    github: { ok: false, reason: "GITHUB_TOKEN not set" },
    linear: { ok: false, reason: "LINEAR_API_KEY not set" },
    docs: { concept: null, roadmap: null, feature: null, handoff: null, driftedAgainstMain: [] },
    ...overrides,
  };
}

describe("buildSystemPrompt docs drift warning", () => {
  test("omits the drift warning when nothing drifted", () => {
    const prompt = buildSystemPrompt(baseContext());
    expect(prompt).not.toContain("Drift:");
  });

  test("warns about drifted docs and names them", () => {
    const prompt = buildSystemPrompt(
      baseContext({
        docs: { concept: null, roadmap: null, feature: null, handoff: null, driftedAgainstMain: ["CONCEPT.md"] },
      }),
    );
    expect(prompt).toContain("Drift: CONCEPT.md differ between this branch and main");
  });

  test("names every drifted doc", () => {
    const prompt = buildSystemPrompt(
      baseContext({
        docs: {
          concept: null,
          roadmap: null,
          feature: null,
          handoff: null,
          driftedAgainstMain: ["CONCEPT.md", "ROADMAP.md"],
        },
      }),
    );
    expect(prompt).toContain("Drift: CONCEPT.md, ROADMAP.md differ between this branch and main");
  });
});
