import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { compressForSummary, deleteTranscript, loadTranscript, saveTranscript, transcriptPath } from "./transcript";

describe("transcriptPath", () => {
  test("keys the path by owner, repo and branch, sanitizing slashes", () => {
    expect(transcriptPath("/base", "acme", "demo", "feature/x")).toBe(join("/base", "acme-demo", "feature-x.json"));
  });
});

describe("save/load/delete transcript", () => {
  let baseDir: string;
  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "nook-transcript-test-"));
  });
  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  const messages: AgentMessage[] = [
    { role: "user", content: "do the thing", timestamp: 1 } as AgentMessage,
  ];

  test("loadTranscript returns null when nothing was saved", async () => {
    expect(await loadTranscript(join(baseDir, "acme-demo", "feature-x.json"))).toBeNull();
  });

  test("round-trips saved messages", async () => {
    const path = transcriptPath(baseDir, "acme", "demo", "feature-x");
    await saveTranscript(path, messages);
    expect(await loadTranscript(path)).toEqual(messages);
  });

  test("overwrites rather than accumulates across saves", async () => {
    const path = transcriptPath(baseDir, "acme", "demo", "feature-x");
    await saveTranscript(path, messages);
    const second: AgentMessage[] = [{ role: "user", content: "second run", timestamp: 2 } as AgentMessage];
    await saveTranscript(path, second);
    expect(await loadTranscript(path)).toEqual(second);
  });

  test("deleteTranscript removes the file", async () => {
    const path = transcriptPath(baseDir, "acme", "demo", "feature-x");
    await saveTranscript(path, messages);
    await deleteTranscript(path);
    expect(await loadTranscript(path)).toBeNull();
  });

  test("deleteTranscript is a no-op when nothing exists", async () => {
    await expect(deleteTranscript(join(baseDir, "never-existed.json"))).resolves.toBeUndefined();
  });
});

describe("compressForSummary", () => {
  function assistantMessage(content: Record<string, unknown>[]): AgentMessage {
    return {
      role: "assistant",
      content,
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-5",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      stopReason: "stop",
      timestamp: 0,
    } as unknown as AgentMessage;
  }

  test("drops thinking blocks entirely", () => {
    const [compressed] = compressForSummary([
      assistantMessage([
        { type: "thinking", thinking: "let me consider the options at length" },
        { type: "text", text: "done" },
      ]),
    ]);
    const content = (compressed as { content: { type: string }[] }).content;
    expect(content.map((b) => b.type)).toEqual(["text"]);
  });

  test("truncates long tool-call argument values but keeps short ones", () => {
    const longContent = "x".repeat(5000);
    const [compressed] = compressForSummary([
      assistantMessage([
        {
          type: "toolCall",
          id: "1",
          name: "write_file",
          arguments: { path: "src/index.ts", content: longContent },
        },
      ]),
    ]);
    const toolCall = (compressed as { content: { type: string; arguments: Record<string, unknown> }[] }).content[0];
    if (!toolCall) throw new Error("expected a compressed tool call");
    expect(toolCall.arguments.path).toBe("src/index.ts");
    expect((toolCall.arguments.content as string).length).toBeLessThan(longContent.length);
    expect(toolCall.arguments.content as string).toContain("5000 chars total");
  });

  test("leaves non-assistant messages untouched", () => {
    const userMessage = { role: "user", content: "hello", timestamp: 0 } as AgentMessage;
    expect(compressForSummary([userMessage])).toEqual([userMessage]);
  });
});
