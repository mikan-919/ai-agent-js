import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { WORKSPACE_DOCUMENT_FILES } from "../config";
import { pushBranch } from "./pullRequest";
import { resolveSandboxPath } from "./sandboxTools";

/** The only files the docs agent's tools are allowed to touch — see CLAUDE.md's document responsibility table. */
export const DOCS_FILES = WORKSPACE_DOCUMENT_FILES;
export type DocsFile = (typeof DOCS_FILES)[number];

function assertDocsFile(path: string): asserts path is DocsFile {
  if (!(DOCS_FILES as readonly string[]).includes(path)) {
    throw new Error(`path '${path}' is not one of the workspace docs this agent may touch (${DOCS_FILES.join(", ")})`);
  }
}

function textResult(text: string): AgentToolResult<Record<string, never>> {
  return { content: [{ type: "text", text }], details: {} };
}

const readFileParams = Type.Object({ path: Type.String({ description: `One of: ${DOCS_FILES.join(", ")}` }) });

export function createDocsReadFileTool(cwd: string): AgentTool<typeof readFileParams> {
  return {
    name: "read_file",
    label: "Read doc",
    description: `Read one of the workspace docs (${DOCS_FILES.join(", ")}).`,
    parameters: readFileParams,
    execute: async (_toolCallId, params) => {
      assertDocsFile(params.path);
      const file = Bun.file(resolveSandboxPath(cwd, params.path));
      if (!(await file.exists())) throw new Error(`file not found: ${params.path}`);
      return textResult(await file.text());
    },
  };
}

const writeFileParams = Type.Object({
  path: Type.String({ description: `One of: ${DOCS_FILES.join(", ")}` }),
  content: Type.String(),
});

export function createDocsWriteFileTool(cwd: string): AgentTool<typeof writeFileParams> {
  return {
    name: "write_file",
    label: "Write doc",
    description: `Create or overwrite one of the workspace docs (${DOCS_FILES.join(", ")}).`,
    parameters: writeFileParams,
    execute: async (_toolCallId, params) => {
      assertDocsFile(params.path);
      await Bun.write(resolveSandboxPath(cwd, params.path), params.content);
      return textResult(`wrote ${params.path}`);
    },
  };
}

const editFileParams = Type.Object({
  path: Type.String({ description: `One of: ${DOCS_FILES.join(", ")}` }),
  old_string: Type.String(),
  new_string: Type.String(),
});

export function createDocsEditFileTool(cwd: string): AgentTool<typeof editFileParams> {
  return {
    name: "edit_file",
    label: "Edit doc",
    description: "Replace an exact, unique occurrence of old_string with new_string in one of the workspace docs.",
    parameters: editFileParams,
    execute: async (_toolCallId, params) => {
      assertDocsFile(params.path);
      const path = resolveSandboxPath(cwd, params.path);
      const file = Bun.file(path);
      if (!(await file.exists())) throw new Error(`file not found: ${params.path}`);
      const content = await file.text();
      const occurrences = content.split(params.old_string).length - 1;
      if (occurrences === 0) throw new Error(`old_string not found in ${params.path}`);
      if (occurrences > 1) throw new Error(`old_string is not unique in ${params.path} (${occurrences} matches)`);
      await Bun.write(path, content.replace(params.old_string, params.new_string));
      return textResult(`edited ${params.path}`);
    },
  };
}

async function runGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

const commitParams = Type.Object({ message: Type.String({ description: "Commit message" }) });

export function createDocsCommitTool(cwd: string): AgentTool<typeof commitParams> {
  return {
    name: "git_commit",
    label: "Commit docs",
    description: `Stage and commit changes to the workspace docs (${DOCS_FILES.join(", ")}) only. Staging is limited to these files, so this can't accidentally commit anything else in the working tree.`,
    parameters: commitParams,
    execute: async (_toolCallId, params) => {
      const add = await runGit(cwd, ["add", ...DOCS_FILES]);
      if (add.exitCode !== 0) throw new Error(`git add failed: ${add.stderr || add.stdout}`);

      const commit = await runGit(cwd, ["commit", "-m", params.message]);
      const text = [commit.stdout, commit.stderr].filter((s) => s.length > 0).join("\n");
      // A non-zero exit here is most often "nothing to commit" (e.g. the
      // human asked to commit again with no new edits) — a legitimate
      // outcome to report back to the agent, not a tool failure.
      return textResult(text || `git commit exited ${commit.exitCode}`);
    },
  };
}

export interface DocsPushOptions {
  branch: string;
  mainBranch: string;
  token: string;
}

const pushParams = Type.Object({});

export function createDocsPushTool(cwd: string, opts: DocsPushOptions): AgentTool<typeof pushParams> {
  return {
    name: "git_push",
    label: "Push docs branch",
    description:
      "Push committed changes on the current branch to origin. Commit with git_commit first — this tool does not commit.",
    parameters: pushParams,
    execute: async () => {
      if (opts.branch === opts.mainBranch) {
        throw new Error(
          `refusing to push directly to '${opts.mainBranch}' — this would land doc changes without going through a PR. ` +
            "Check out a non-main branch first.",
        );
      }
      await pushBranch(cwd, opts.branch, opts.token);
      return textResult(`pushed ${opts.branch} to origin`);
    },
  };
}

export function createDocsTools(cwd: string, pushOpts: DocsPushOptions): AgentTool[] {
  return [
    createDocsReadFileTool(cwd),
    createDocsWriteFileTool(cwd),
    createDocsEditFileTool(cwd),
    createDocsCommitTool(cwd),
    createDocsPushTool(cwd, pushOpts),
  ];
}
