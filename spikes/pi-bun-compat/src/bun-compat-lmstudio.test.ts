import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createModels, createProvider, type Model } from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";

/**
 * Emulates the wire protocol pi-ai's openai-responses API implementation
 * expects (SSE `data:` lines whose JSON payload carries a `type` field),
 * matching what a real LM Studio /v1/responses endpoint would return.
 */
interface RecordedRequest {
  method: string;
  pathname: string;
  body: {
    model?: unknown;
    stream?: unknown;
    input?: unknown;
  };
}

describe("Seam E: LM Studio interim provider (OpenAI Responses over a local mock)", () => {
  let server: ReturnType<typeof Bun.serve>;
  const requestsSeen: RecordedRequest[] = [];

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const body = await req.json();
        requestsSeen.push({ method: req.method, pathname: url.pathname, body });

        const events = [
          { type: "response.created", response: { id: "resp_1" } },
          { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1" } },
          { type: "response.output_text.delta", output_index: 0, delta: "hello from lm studio" },
          {
            type: "response.output_item.done",
            output_index: 0,
            item: {
              type: "message",
              id: "msg_1",
              content: [{ type: "output_text", text: "hello from lm studio" }],
            },
          },
          {
            type: "response.completed",
            response: {
              id: "resp_1",
              status: "completed",
              output: [],
              usage: { input_tokens: 1, output_tokens: 3, total_tokens: 4 },
            },
          },
        ];
        const sseBody = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
        return new Response(sseBody, { headers: { "content-type": "text/event-stream" } });
      },
    });
  });

  afterAll(() => {
    server.stop();
  });

  test("resolves a completed assistant message through the OpenAI Responses API on Bun", async () => {
    const baseUrl = `http://localhost:${server.port}/v1`;
    const model: Model<"openai-responses"> = {
      id: "qwen/qwen3-8b",
      name: "LM Studio: qwen/qwen3-8b",
      api: "openai-responses",
      provider: "openai",
      baseUrl,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32768,
      maxTokens: 8192,
    };

    const provider = createProvider({
      id: "openai",
      name: "LM Studio (OpenAI-compatible)",
      baseUrl,
      auth: {
        apiKey: {
          name: "LM Studio API key",
          resolve: async () => ({ auth: { apiKey: "lm-studio" }, source: "LM Studio default" }),
        },
      },
      models: [model],
      api: { "openai-responses": openAIResponsesApi() },
    });

    const models = createModels();
    models.setProvider(provider);

    const context = { messages: [{ role: "user" as const, content: "hi", timestamp: Date.now() }] };
    const result = await models.complete(model, context);

    expect(result.stopReason).toBe("stop");
    expect(result.content.some((c) => c.type === "text" && c.text === "hello from lm studio")).toBe(true);

    const request = requestsSeen.find((r) => r.method === "POST" && r.pathname === "/v1/responses");
    expect(request).toBeDefined();
    if (!request) throw new Error("unreachable");

    // Minimum request shape a real LM Studio /v1/responses endpoint must see:
    // the selected model id, streaming explicitly enabled, and the user's
    // input text carried through as an OpenAI Responses "input_text" item.
    expect(request.body.model).toBe("qwen/qwen3-8b");
    expect(request.body.stream).toBe(true);
    expect(Array.isArray(request.body.input)).toBe(true);
    const inputItems = request.body.input as Array<{ role?: string; content?: Array<{ type?: string; text?: string }> }>;
    const userItem = inputItems.find((item) => item.role === "user");
    expect(userItem).toBeDefined();
    expect(userItem?.content?.some((c) => c.type === "input_text" && c.text === "hi")).toBe(true);
  });
});
