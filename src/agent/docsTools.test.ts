import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createDocsEditFileTool, createDocsPushTool, createDocsReadFileTool, createDocsWriteFileTool } from "./docsTools";

describe("docs tools file allowlist", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agent-harness-docs-tools-"));
    await Bun.write(join(dir, "CONCEPT.md"), "concept content");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("read_file allows one of the four docs", async () => {
    const tool = createDocsReadFileTool(dir);
    const result = await tool.execute("call-1", { path: "CONCEPT.md" }, new AbortController().signal);
    expect(result.content).toEqual([{ type: "text", text: "concept content" }]);
  });

  test("read_file rejects a file outside the allowlist", async () => {
    await expect(
      createDocsReadFileTool(dir).execute("call-1", { path: "package.json" }, new AbortController().signal),
    ).rejects.toThrow("is not one of the workspace docs");
  });

  test("write_file rejects a file outside the allowlist", async () => {
    await expect(
      createDocsWriteFileTool(dir).execute(
        "call-1",
        { path: "src/index.ts", content: "malicious" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("is not one of the workspace docs");
  });

  test("edit_file rejects a file outside the allowlist", async () => {
    await expect(
      createDocsEditFileTool(dir).execute(
        "call-1",
        { path: "CLAUDE.md", old_string: "a", new_string: "b" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("is not one of the workspace docs");
  });

  test("write_file allows one of the four docs and actually writes it", async () => {
    await createDocsWriteFileTool(dir).execute(
      "call-1",
      { path: "ROADMAP.md", content: "new roadmap" },
      new AbortController().signal,
    );
    expect(await Bun.file(join(dir, "ROADMAP.md")).text()).toBe("new roadmap");
  });
});

describe("git_push main-branch guard", () => {
  test("refuses to push when the current branch is the repo's main branch", async () => {
    const tool = createDocsPushTool("/irrelevant", { branch: "main", mainBranch: "main", token: "fake-token" });
    await expect(tool.execute("call-1", {}, new AbortController().signal)).rejects.toThrow(
      "refusing to push directly to 'main'",
    );
  });
});
