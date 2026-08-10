import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { RunAgentResult } from "../../src/agent/types";
import type { WorkContext } from "../../src/context/types";

export type WorkContextResponse =
  | { ok: true; workContext: WorkContext; resumed: boolean }
  | { ok: false; error: string };

export async function fetchWorkContext(branch: string): Promise<WorkContextResponse> {
  const res = await fetch(`/work-context/${encodeURIComponent(branch)}`);
  try {
    return (await res.json()) as WorkContextResponse;
  } catch {
    return { ok: false, error: `server returned a non-JSON response (status ${res.status})` };
  }
}

export interface StreamAgentRunCallbacks {
  onEvent: (event: AgentEvent) => void;
  onEnd: (result: RunAgentResult) => void;
  onError: (error: string) => void;
}

/**
 * Manually parses the text/event-stream body POST /agent/run/stream returns
 * (hono's streamSSE format: "event: <name>\ndata: <line>\n\n"). Plain
 * EventSource can't be used here since it only supports GET — the prompt is
 * sent as a POST body instead.
 */
export async function streamAgentRun(
  branch: string,
  prompt: string,
  callbacks: StreamAgentRunCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch("/agent/run/stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ branch, prompt }),
    signal,
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    callbacks.onError(text || `request failed with status ${res.status}`);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let separatorIndex: number;
    while ((separatorIndex = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      dispatchSseEvent(rawEvent, callbacks);
    }
  }
}

function dispatchSseEvent(raw: string, callbacks: StreamAgentRunCallbacks): void {
  let eventName = "message";
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) eventName = line.slice("event:".length).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trim());
  }
  if (dataLines.length === 0) return;
  const data = dataLines.join("\n");

  if (eventName === "agent") {
    callbacks.onEvent(JSON.parse(data) as AgentEvent);
  } else if (eventName === "run_end") {
    callbacks.onEnd(JSON.parse(data) as RunAgentResult);
  }
}
