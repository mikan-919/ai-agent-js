import { describe, expect, test } from "bun:test";
import type { WorkContext } from "../context";
import { formatCreateSandboxResult, formatDestroySandboxResult, formatWorkContext } from "./format";

function baseContext(overrides: Partial<WorkContext> = {}): WorkContext {
  return {
    git: {
      branch: "feature/x",
      mainBranch: "main",
      diff: { files: [], filesChanged: 2, insertions: 10, deletions: 3 },
    },
    github: { ok: false, reason: "GITHUB_TOKEN not set" },
    linear: { ok: false, reason: "LINEAR_API_KEY not set" },
    docs: { concept: null, roadmap: null, feature: null, handoff: null },
    ...overrides,
  };
}

describe("formatWorkContext", () => {
  test("includes branch and diff summary", () => {
    const output = formatWorkContext(baseContext());
    expect(output).toContain("Branch: feature/x (main: main)");
    expect(output).toContain("Diff: 2 files changed, +10 -3");
  });

  test("reports unavailable sources with their reason", () => {
    const output = formatWorkContext(baseContext());
    expect(output).toContain("unavailable: GITHUB_TOKEN not set");
    expect(output).toContain("unavailable: LINEAR_API_KEY not set");
  });

  test("formats a resolved PR and linked issues", () => {
    const output = formatWorkContext(
      baseContext({
        github: {
          ok: true,
          data: {
            owner: "acme",
            repo: "demo",
            pullRequest: {
              number: 42,
              title: "Add feature",
              state: "open",
              isDraft: true,
              url: "https://github.com/acme/demo/pull/42",
              body: null,
              headRefName: "feature/x",
              baseRefName: "main",
            },
            linkedIssues: [{ number: 7, title: "Bug", state: "open", url: "https://github.com/acme/demo/issues/7" }],
          },
        },
      }),
    );
    expect(output).toContain("PR #42 [draft] Add feature (open) https://github.com/acme/demo/pull/42");
    expect(output).toContain("Linked issues: #7");
  });

  test("reports no PR yet when github resolves but finds none", () => {
    const output = formatWorkContext(
      baseContext({ github: { ok: true, data: { owner: "acme", repo: "demo", pullRequest: null, linkedIssues: [] } } }),
    );
    expect(output).toContain("no PR yet for this branch");
  });

  test("formats a resolved linear issue", () => {
    const output = formatWorkContext(
      baseContext({
        linear: {
          ok: true,
          data: {
            id: "id-1",
            identifier: "ENG-1",
            title: "Do the thing",
            description: null,
            url: "https://linear.app/acme/issue/ENG-1",
            state: { name: "In Progress", type: "started" },
            team: { key: "ENG", name: "Engineering" },
          },
        },
      }),
    );
    expect(output).toContain("ENG-1 Do the thing (In Progress) https://linear.app/acme/issue/ENG-1");
  });

  test("excerpts a doc's heading and first paragraph, skipping sub-headings", () => {
    const output = formatWorkContext(
      baseContext({
        docs: {
          concept: "# CONCEPT\n\n## why\n\nThis is the first paragraph explaining things.",
          roadmap: null,
          feature: null,
          handoff: null,
        },
      }),
    );
    expect(output).toContain("CONCEPT.md: CONCEPT — This is the first paragraph explaining things.");
    expect(output).toContain("ROADMAP.md: (not found)");
  });

  test("truncates long excerpts", () => {
    const longLine = "x".repeat(200);
    const output = formatWorkContext(
      baseContext({ docs: { concept: `# T\n\n${longLine}`, roadmap: null, feature: null, handoff: null } }),
    );
    expect(output).toContain(`${"x".repeat(160)}…`);
    expect(output).not.toContain(longLine);
  });
});

describe("formatCreateSandboxResult", () => {
  test("formats a newly created sandbox", () => {
    const output = formatCreateSandboxResult({
      ok: true,
      sandbox: {
        branch: "feature/x",
        backend: "worktree",
        path: "/home/user/.nook/sandboxes/acme-demo/feature-x",
        holder: "host:123",
        createdAt: "2026-08-10T00:00:00.000Z",
        resumed: false,
      },
    });
    expect(output).toBe(
      "sandbox created: feature/x [worktree] -> /home/user/.nook/sandboxes/acme-demo/feature-x (holder: host:123)",
    );
  });

  test("distinguishes a resumed sandbox", () => {
    const output = formatCreateSandboxResult({
      ok: true,
      sandbox: {
        branch: "feature/x",
        backend: "docker",
        path: "/workspace",
        holder: "host:123",
        createdAt: "2026-08-10T00:00:00.000Z",
        resumed: true,
      },
    });
    expect(output).toContain("sandbox resumed: feature/x [docker]");
  });

  test("formats an error", () => {
    const output = formatCreateSandboxResult({ ok: false, error: "branch 'feature/x' is locked by 'other'" });
    expect(output).toBe("error: branch 'feature/x' is locked by 'other'");
  });
});

describe("formatDestroySandboxResult", () => {
  test("formats success", () => {
    expect(formatDestroySandboxResult("feature/x", { ok: true })).toBe("sandbox destroyed: feature/x");
  });

  test("formats an error", () => {
    expect(formatDestroySandboxResult("feature/x", { ok: false, error: "uncommitted changes" })).toBe(
      "error: uncommitted changes",
    );
  });
});
