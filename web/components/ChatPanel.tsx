import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { AlertCircle, CheckCircle2, Loader2, MessageSquare, Send, Wrench } from "lucide-react";
import { useRef, useState } from "react";
import { streamAgentRun } from "../lib/api";
import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import { Textarea } from "./ui/textarea";

type ChatBlock =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string }
  | { kind: "tool"; id: string; toolName: string; args: unknown; status: "running" | "done" | "error"; result?: unknown }
  | { kind: "system"; id: string; text: string; tone: "info" | "error" };

let nextId = 0;
const newId = () => `b${nextId++}`;

export function ChatPanel({ branch, onRunEnd }: { branch: string; onRunEnd: () => void }) {
  const [blocks, setBlocks] = useState<ChatBlock[]>([]);
  const [prompt, setPrompt] = useState("");
  const [running, setRunning] = useState(false);
  const activeAssistantId = useRef<string | null>(null);

  const applyEvent = (event: AgentEvent) => {
    setBlocks((prev) => {
      const next = [...prev];

      if (event.type === "message_start") {
        if (event.message.role === "assistant") {
          const id = newId();
          activeAssistantId.current = id;
          next.push({ kind: "assistant", id, text: "" });
        }
        return next;
      }

      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        const id = activeAssistantId.current;
        const idx = next.findIndex((b) => b.kind === "assistant" && b.id === id);
        if (idx !== -1) {
          const block = next[idx] as Extract<ChatBlock, { kind: "assistant" }>;
          next[idx] = { ...block, text: block.text + event.assistantMessageEvent.delta };
        }
        return next;
      }

      if (event.type === "tool_execution_start") {
        next.push({ kind: "tool", id: event.toolCallId, toolName: event.toolName, args: event.args, status: "running" });
        return next;
      }

      if (event.type === "tool_execution_end") {
        const idx = next.findIndex((b) => b.kind === "tool" && b.id === event.toolCallId);
        if (idx !== -1) {
          const block = next[idx] as Extract<ChatBlock, { kind: "tool" }>;
          next[idx] = { ...block, status: event.isError ? "error" : "done", result: event.result };
        }
        return next;
      }

      return next;
    });
  };

  const send = async () => {
    const text = prompt.trim();
    if (!text || running) return;

    setPrompt("");
    setRunning(true);
    setBlocks((prev) => [...prev, { kind: "user", id: newId(), text }]);
    activeAssistantId.current = null;

    try {
      await streamAgentRun(branch, text, {
        onEvent: applyEvent,
        onEnd: (result) => {
          setBlocks((prev) => [
            ...prev,
            result.ok
              ? {
                  kind: "system",
                  id: newId(),
                  tone: "info",
                  text: result.pullRequest
                    ? `PR ${result.pullRequest.created ? "作成" : "更新"}: ${result.pullRequest.url}`
                    : "完了（PRの作成/更新はなし）",
                }
              : {
                  kind: "system",
                  id: newId(),
                  tone: "error",
                  text: result.timedOut ? `アイドルタイムアウト: ${result.error}` : result.error,
                },
          ]);
        },
        onError: (error) => {
          setBlocks((prev) => [...prev, { kind: "system", id: newId(), tone: "error", text: error }]);
        },
      });
    } finally {
      setRunning(false);
      onRunEnd();
    }
  };

  return (
    <div className="flex h-full flex-col">
      <ScrollArea className="flex-1">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-6 py-5">
          {blocks.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-16 text-center text-muted-foreground">
              <MessageSquare className="size-7 opacity-40" />
              <p className="max-w-sm text-sm">
                「<span className="font-mono">{branch}</span>」のsandboxでagentと対話します。指示を送ってください。
              </p>
            </div>
          )}
          {blocks.map((block) => (
            <ChatBlockView key={block.id} block={block} />
          ))}
          {running && (
            <div className="flex items-center gap-1.5 pl-1 text-sm text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              実行中…
            </div>
          )}
        </div>
      </ScrollArea>
      <div className="border-t border-border bg-card/60 px-6 py-4">
        <form
          className="mx-auto flex w-full max-w-3xl items-end gap-2 rounded-xl border border-border bg-card p-2 shadow-sm focus-within:ring-2 focus-within:ring-ring"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder="agentへの指示を入力（Enterで送信、Shift+Enterで改行）"
            disabled={running}
            className="min-h-12 resize-none border-none bg-transparent shadow-none focus-visible:ring-0"
          />
          <Button type="submit" size="icon" disabled={running || prompt.trim().length === 0}>
            <Send className="size-4" />
          </Button>
        </form>
      </div>
    </div>
  );
}

function ChatBlockView({ block }: { block: ChatBlock }) {
  if (block.kind === "user") {
    return (
      <div className="ml-auto max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-3.5 py-2.5 text-sm whitespace-pre-wrap text-primary-foreground shadow-sm">
        {block.text}
      </div>
    );
  }

  if (block.kind === "assistant") {
    return (
      <div className="max-w-[85%] rounded-2xl rounded-bl-sm border border-border bg-card px-3.5 py-2.5 text-sm whitespace-pre-wrap text-card-foreground shadow-sm">
        {block.text || <span className="text-muted-foreground">…</span>}
      </div>
    );
  }

  if (block.kind === "tool") {
    return (
      <div className="flex max-w-[85%] items-center gap-1.5 rounded-full border border-border bg-muted/70 px-3 py-1.5 font-mono text-xs text-muted-foreground">
        {block.status === "running" ? (
          <Loader2 className="size-3 shrink-0 animate-spin" />
        ) : block.status === "error" ? (
          <AlertCircle className="size-3 shrink-0 text-destructive" />
        ) : (
          <CheckCircle2 className="size-3 shrink-0 text-success" />
        )}
        <span className="truncate">{block.toolName}</span>
        {block.status !== "running" && (
          <Badge variant={block.status === "error" ? "destructive" : "outline"} className="ml-auto">
            {block.status}
          </Badge>
        )}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "mx-auto flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs",
        block.tone === "error" ? "bg-destructive/10 text-destructive" : "bg-success/10 text-success",
      )}
    >
      {block.tone === "error" ? (
        <AlertCircle className="size-3.5 shrink-0" />
      ) : (
        <CheckCircle2 className="size-3.5 shrink-0" />
      )}
      <span className="whitespace-pre-wrap">{block.text}</span>
    </div>
  );
}
