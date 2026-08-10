import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

const MAX_BASH_OUTPUT = 100_000;

/**
 * Resolves a tool-supplied path against the sandbox root and rejects any
 * result that lands outside it (`..` traversal or an absolute path
 * elsewhere on the host) — the sandbox directory is the only filesystem
 * boundary these tools are supposed to see.
 */
export function resolveSandboxPath(cwd: string, requestedPath: string): string {
  const resolved = resolve(cwd, requestedPath);
  const rel = relative(cwd, resolved);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`path '${requestedPath}' escapes the sandbox`);
  }
  return resolved;
}

function textResult(text: string): AgentToolResult<Record<string, never>> {
  return { content: [{ type: "text", text }], details: {} };
}

function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? `${text.slice(0, maxLen)}\n… (truncated)` : text;
}

const readFileParams = Type.Object({ path: Type.String({ description: "Path relative to the sandbox root" }) });

export function createReadFileTool(cwd: string): AgentTool<typeof readFileParams> {
  return {
    name: "read_file",
    label: "Read file",
    description: "Read a file's contents, relative to the sandbox root.",
    parameters: readFileParams,
    execute: async (_toolCallId, params) => {
      const file = Bun.file(resolveSandboxPath(cwd, params.path));
      if (!(await file.exists())) throw new Error(`file not found: ${params.path}`);
      return textResult(await file.text());
    },
  };
}

const writeFileParams = Type.Object({
  path: Type.String({ description: "Path relative to the sandbox root" }),
  content: Type.String(),
});

export function createWriteFileTool(cwd: string): AgentTool<typeof writeFileParams> {
  return {
    name: "write_file",
    label: "Write file",
    description: "Create or overwrite a file, relative to the sandbox root.",
    parameters: writeFileParams,
    execute: async (_toolCallId, params) => {
      await Bun.write(resolveSandboxPath(cwd, params.path), params.content);
      return textResult(`wrote ${params.path}`);
    },
  };
}

const editFileParams = Type.Object({
  path: Type.String({ description: "Path relative to the sandbox root" }),
  old_string: Type.String(),
  new_string: Type.String(),
});

export function createEditFileTool(cwd: string): AgentTool<typeof editFileParams> {
  return {
    name: "edit_file",
    label: "Edit file",
    description:
      "Replace an exact, unique occurrence of old_string with new_string in a file, relative to the sandbox root.",
    parameters: editFileParams,
    execute: async (_toolCallId, params) => {
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

const bashParams = Type.Object({ command: Type.String() });

export function createBashTool(cwd: string): AgentTool<typeof bashParams> {
  return {
    name: "bash",
    label: "Bash",
    description: "Run a shell command in the sandbox root.",
    parameters: bashParams,
    execute: async (_toolCallId, params, signal) => {
      const proc = Bun.spawn(["bash", "-lc", params.command], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        signal,
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      const text = truncate(
        [`$ ${params.command}`, stdout, stderr, `(exit code ${exitCode})`].filter((s) => s.length > 0).join("\n"),
        MAX_BASH_OUTPUT,
      );
      return textResult(text);
    },
  };
}

export function createSandboxTools(cwd: string): AgentTool[] {
  return [createReadFileTool(cwd), createWriteFileTool(cwd), createEditFileTool(cwd), createBashTool(cwd)];
}
