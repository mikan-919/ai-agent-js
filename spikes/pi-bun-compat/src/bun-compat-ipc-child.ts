import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxThinking } from "@earendil-works/pi-ai";

/**
 * IPC seam child: receives one JSON line of input on stdin, streams a scripted
 * pi-ai response, and re-emits each AssistantMessageEvent as one NDJSON line
 * on stdout, unmodified. The parent process must not need to reshape events.
 */
async function main() {
  const input = await new Response(Bun.stdin.stream()).text();
  const { prompt } = JSON.parse(input) as { prompt: string };

  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();

  faux.setResponses([
    fauxAssistantMessage([fauxThinking("thinking in a child process"), fauxText(`echo: ${prompt}`)], {
      stopReason: "stop",
    }),
  ]);

  const context = { messages: [{ role: "user" as const, content: prompt, timestamp: Date.now() }] };

  for await (const event of models.stream(model, context)) {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  }
}

await main();
