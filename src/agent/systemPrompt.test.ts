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

describe("buildSystemPrompt previous session summary", () => {
  test("omits the section when there is no prior summary", () => {
    const prompt = buildSystemPrompt(baseContext());
    expect(prompt).not.toContain("Previous session in this sandbox");
  });

  test("omits the section for a resumed sandbox with no stored transcript", () => {
    const prompt = buildSystemPrompt(baseContext(), { previousSessionSummary: null });
    expect(prompt).not.toContain("Previous session in this sandbox");
  });

  test("includes the summary text when one is provided", () => {
    const prompt = buildSystemPrompt(baseContext(), { previousSessionSummary: "## Goal\nFix the flaky test" });
    expect(prompt).toContain("## Previous session in this sandbox");
    expect(prompt).toContain("Fix the flaky test");
  });
});
