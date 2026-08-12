import { describe, expect, test } from "bun:test";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
  Type,
  type AssistantMessageEvent,
} from "@earendil-works/pi-ai";
import { Agent, type AgentEvent, type AgentTool } from "@earendil-works/pi-agent-core";

describe("Seam A: text/thinking stream on Bun", () => {
  test("streams thinking deltas before text deltas and ends with a completed message", async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const model = faux.getModel();

    faux.setResponses([
      fauxAssistantMessage([fauxThinking("thinking about it"), fauxText("hello from bun")], {
        stopReason: "stop",
      }),
    ]);

    const context = {
      messages: [{ role: "user" as const, content: "hi", timestamp: Date.now() }],
    };

    const events: AssistantMessageEvent[] = [];
    for await (const event of models.stream(model, context)) {
      events.push(event);
    }

    const types = events.map((e) => e.type);
    const lastThinkingIndex = types.lastIndexOf("thinking_delta");
    const firstTextIndex = types.indexOf("text_delta");
    expect(lastThinkingIndex).toBeGreaterThanOrEqual(0);
    expect(firstTextIndex).toBeGreaterThan(lastThinkingIndex);

    const done = events.at(-1);
    expect(done?.type).toBe("done");
    if (done?.type !== "done") throw new Error("unreachable");
    expect(done.reason).toBe("stop");
    expect(done.message.content.some((c) => c.type === "text" && c.text === "hello from bun")).toBe(true);
  });
});

describe("Seam B: tool call arguments and the next turn after execution", () => {
  test("Agent executes a tool call then continues with a follow-up assistant turn", async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const model = faux.getModel();

    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("echo", { text: "package.json" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("tool said: package.json contents")], { stopReason: "stop" }),
    ]);

    const echoTool: AgentTool = {
      name: "echo",
      label: "Echo",
      description: "Echoes the given text back as the tool result.",
      parameters: Type.Object({ text: Type.String() }),
      execute: async (_toolCallId, params: { text: string }) => ({
        content: [{ type: "text", text: `${params.text} contents` }],
        details: params.text,
      }),
    };

    const agent = new Agent({
      initialState: {
        systemPrompt: "You are a helpful assistant.",
        model,
        tools: [echoTool],
      },
      streamFn: models.streamSimple.bind(models),
    });

    const events: AgentEvent[] = [];
    agent.subscribe((event) => {
      events.push(event);
    });

    await agent.prompt("Summarize package.json and then call echo");

    const types = events.map((e) => e.type);
    expect(types).toContain("tool_execution_start");
    expect(types).toContain("tool_execution_end");

    // Reconstruct the tool call arguments purely from the streamed
    // toolcall_delta chunks on public message_update events (the same events
    // a UI would consume), instead of trusting only the already-parsed args
    // pi-agent-core hands to tool_execution_start.
    const toolcallDeltaIndex = events.findIndex(
      (e) => e.type === "message_update" && e.assistantMessageEvent.type === "toolcall_delta",
    );
    const toolExecutionStartIndex = events.findIndex((e) => e.type === "tool_execution_start");
    expect(toolcallDeltaIndex).toBeGreaterThanOrEqual(0);
    expect(toolExecutionStartIndex).toBeGreaterThan(toolcallDeltaIndex);

    const streamedArgumentsJson = events
      .filter((e) => e.type === "message_update" && e.assistantMessageEvent.type === "toolcall_delta")
      .map((e) => {
        if (e.type !== "message_update" || e.assistantMessageEvent.type !== "toolcall_delta") {
          throw new Error("unreachable");
        }
        return e.assistantMessageEvent.delta;
      })
      .join("");
    expect(JSON.parse(streamedArgumentsJson)).toEqual({ text: "package.json" });

    const toolStart = events.find((e) => e.type === "tool_execution_start");
    if (toolStart?.type !== "tool_execution_start") throw new Error("unreachable");
    expect(toolStart.toolName).toBe("echo");
    expect(toolStart.args).toEqual({ text: "package.json" });

    const toolEnd = events.find((e) => e.type === "tool_execution_end");
    if (toolEnd?.type !== "tool_execution_end") throw new Error("unreachable");
    expect(toolEnd.result.content.some((c) => c.type === "text" && c.text === "package.json contents")).toBe(true);

    const turnEnds = events.filter((e) => e.type === "turn_end");
    expect(turnEnds.length).toBe(2);

    const agentEnd = events.at(-1);
    expect(agentEnd?.type).toBe("agent_end");
    if (agentEnd?.type !== "agent_end") throw new Error("unreachable");
    const finalAssistant = agentEnd.messages.at(-1);
    const finalContent = finalAssistant && "content" in finalAssistant ? finalAssistant.content : [];
    expect(
      Array.isArray(finalContent) &&
        finalContent.some((c) => c.type === "text" && c.text === "tool said: package.json contents"),
    ).toBe(true);
  });
});

describe("Seam C: abort", () => {
  test("aborting mid-stream ends the run with stopReason 'aborted' instead of throwing", async () => {
    const faux = fauxProvider({ tokensPerSecond: 5 });
    const models = createModels();
    models.setProvider(faux.provider);
    const model = faux.getModel();

    faux.setResponses([fauxAssistantMessage([fauxText("a slow response that should be interrupted")])]);

    const agent = new Agent({
      initialState: { systemPrompt: "You are a helpful assistant.", model },
      streamFn: models.streamSimple.bind(models),
    });

    const events: AgentEvent[] = [];
    agent.subscribe((event) => {
      events.push(event);
    });

    const run = agent.prompt("go slowly");
    await new Promise((resolve) => setTimeout(resolve, 20));
    agent.abort();
    await run;

    const agentEnd = events.at(-1);
    expect(agentEnd?.type).toBe("agent_end");
    if (agentEnd?.type !== "agent_end") throw new Error("unreachable");

    const finalAssistant = agentEnd.messages.at(-1);
    expect(finalAssistant && "stopReason" in finalAssistant ? finalAssistant.stopReason : undefined).toBe("aborted");
  });
});
