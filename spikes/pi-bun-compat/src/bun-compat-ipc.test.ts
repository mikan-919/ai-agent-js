import { describe, expect, test } from "bun:test";
import { createAssistantMessageEventStream, type AssistantMessageEvent, type Model, type StreamFn } from "@earendil-works/pi-ai";
import { Agent, type AgentEvent } from "@earendil-works/pi-agent-core";

const CHILD_PATH = new URL("./bun-compat-ipc-child.ts", import.meta.url).pathname;

interface ChildOutcome {
  exitCode?: number;
  stderrText?: string;
  /**
   * Agent.prompt() resolves as soon as the stream's terminal ("done"/"error")
   * event has been delivered — it does not wait for the child process itself
   * to exit. Callers that need process-exit confirmation must await this
   * separately; the StreamFn contract only settles the event stream.
   */
  done?: Promise<void>;
}

function createIpcStreamFn(promptText: string, outcome: ChildOutcome): StreamFn {
  return () => {
    const stream = createAssistantMessageEventStream();
    outcome.done = (async () => {
      const child = Bun.spawn([process.execPath, CHILD_PATH], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      child.stdin.write(JSON.stringify({ prompt: promptText }));
      child.stdin.end();

      const reader = child.stdout.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          if (line.trim().length === 0) continue;
          const event = JSON.parse(line) as AssistantMessageEvent;
          stream.push(event);
        }
      }

      outcome.exitCode = await child.exited;
      outcome.stderrText = await new Response(child.stderr).text();
    })();
    return stream;
  };
}

describe("Seam D: StreamFn fulfilled across a Bun.spawn child process boundary", () => {
  test("Agent completes a turn whose events crossed an NDJSON child-process pipe unmodified", async () => {
    const outcome: ChildOutcome = {};
    const dummyModel: Model<"openai-responses"> = {
      id: "faux-ipc",
      name: "Faux via IPC",
      api: "openai-responses",
      provider: "faux-ipc",
      baseUrl: "unused",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1000,
      maxTokens: 100,
    };

    const agent = new Agent({
      initialState: { systemPrompt: "You are a helpful assistant.", model: dummyModel },
      streamFn: createIpcStreamFn("hello over ipc", outcome),
    });

    const events: AgentEvent[] = [];
    agent.subscribe((event) => {
      events.push(event);
    });

    await agent.prompt("hello over ipc");
    await outcome.done;

    expect(outcome.exitCode).toBe(0);
    expect(outcome.stderrText).toBe("");

    const thinkingDeltas = events.filter(
      (e) => e.type === "message_update" && e.assistantMessageEvent.type === "thinking_delta",
    );
    expect(thinkingDeltas.length).toBeGreaterThan(0);

    const agentEnd = events.at(-1);
    expect(agentEnd?.type).toBe("agent_end");
    if (agentEnd?.type !== "agent_end") throw new Error("unreachable");
    const finalAssistant = agentEnd.messages.at(-1);
    const finalContent = finalAssistant && "content" in finalAssistant ? finalAssistant.content : [];
    expect(Array.isArray(finalContent) && finalContent.some((c) => c.type === "text" && c.text === "echo: hello over ipc")).toBe(
      true,
    );
  });
});
