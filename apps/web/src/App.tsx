import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  GitPullRequest,
  Hammer,
  HelpCircle,
  Loader2,
  MessageCircle,
  Plus,
  Route,
  Search,
  Wrench,
  X,
} from "lucide-react";

import { identity } from "@mikan-919/oriel-identity";

const csrfHeaderName = `x-${identity.codeName}-csrf`;

interface Job {
  jobId: string;
  kind:
    | "issue_conversation"
    | "implementation"
    | "what_confirmation"
    | "how_confirmation"
    | "pr_response";
  status: string | null;
}

const kindLabel: Record<Job["kind"], string> = {
  issue_conversation: "Issue対話",
  implementation: "実装",
  what_confirmation: "WHAT確定",
  how_confirmation: "HOW確定",
  pr_response: "PR対応",
};

const kindIcon: Record<
  Job["kind"],
  React.ComponentType<{ size?: number; className?: string }>
> = {
  issue_conversation: MessageCircle,
  implementation: Hammer,
  what_confirmation: HelpCircle,
  how_confirmation: Route,
  pr_response: GitPullRequest,
};

interface TranscriptEntry {
  jobId: string;
  sequence: number;
  kind: string;
  content: string;
  createdAt: number;
}

interface ConversationEvent {
  key: string;
  role: "assistant" | "tool" | "system" | "error";
  text: string;
}

/**
 * model.stream.eventの生イベント(pi-aiのAssistantMessageEvent)から、会話として
 * 意味のある要素だけを取り出す。text_delta等の途中経過は積み上げず、確定した
 * text_end/toolcall_end/errorだけを拾う。job.start/job.resultはworker側の
 * 節目としてそのまま系統的イベントに変換する。
 */
function parseTranscriptEvent(
  entry: TranscriptEntry,
): ConversationEvent | null {
  const key = `${entry.jobId}-${entry.sequence}`;

  if (entry.kind === "job.start") {
    return { key, role: "system", text: "Jobを開始しました" };
  }

  if (entry.kind === "job.result") {
    return { key, role: "system", text: entry.content };
  }

  const externalOperationLabel: Record<string, string> = {
    "external.linear_in_progress": "Linear: In Progressへ反映",
    "external.pull_request": "Pull Request",
    "external.review_state": "Linear: レビュー用stateへ反映",
    "external.returned_to_triage": "Linear: Triageへ差し戻し",
  };

  if (entry.kind in externalOperationLabel) {
    let status: unknown;

    try {
      status = (JSON.parse(entry.content) as { status: unknown }).status;
    } catch {
      status = entry.content;
    }

    return {
      key,
      role: "system",
      text: `${externalOperationLabel[entry.kind]}: ${String(status)}`,
    };
  }

  if (entry.kind !== "model.stream.event") {
    return null;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(entry.content);
  } catch {
    return null;
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("type" in parsed) ||
    typeof (parsed as { type: unknown }).type !== "string"
  ) {
    return null;
  }

  const event = parsed as Record<string, unknown>;

  if (event.type === "text_end" && typeof event.content === "string") {
    return { key, role: "assistant", text: event.content };
  }

  if (
    event.type === "toolcall_end" &&
    typeof event.toolCall === "object" &&
    event.toolCall !== null
  ) {
    const toolCall = event.toolCall as { name?: unknown; arguments?: unknown };

    return {
      key,
      role: "tool",
      text: `${String(toolCall.name)}(${JSON.stringify(toolCall.arguments)})`,
    };
  }

  if (event.type === "error") {
    return { key, role: "error", text: JSON.stringify(event.error ?? event) };
  }

  return null;
}

/** 一覧に残っているJobは稼働中が既定。明確な拒否/失敗語だけ静止表示にする。 */
function statusTone(status: string | null): "live" | "fail" {
  if (status === null) {
    return "live";
  }

  const lowered = status.toLowerCase();

  return lowered.includes("fail") ||
    lowered.includes("refused") ||
    lowered.includes("error")
    ? "fail"
    : "live";
}

async function postJson(
  path: string,
  csrfToken: string,
  body: unknown,
): Promise<{ ok: boolean; body: unknown }> {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [csrfHeaderName]: csrfToken,
    },
    body: JSON.stringify(body),
  });

  return { ok: response.ok, body: await response.json().catch(() => null) };
}

/** 出窓の格子(mullion)をかたどった、Orielのワードマーク用ロゴ。 */
function Logo() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden
      className="shrink-0"
    >
      <rect
        x="1"
        y="1"
        width="18"
        height="18"
        rx="3"
        stroke="var(--color-accent)"
        strokeWidth="1.4"
      />
      <path
        d="M10 1.5V18.5M1.5 10H18.5"
        stroke="var(--color-accent)"
        strokeWidth="1.4"
        strokeOpacity="0.55"
      />
    </svg>
  );
}

const inputClass =
  "w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text placeholder:text-faint transition-colors focus:border-accent focus:outline-none";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="text-muted">{label}</span>
      {children}
    </label>
  );
}

function PrimaryButton({
  disabled,
  children,
}: {
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="submit"
      disabled={disabled}
      className="inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-sidebar shadow-sm transition-all hover:bg-accent-hover active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100"
    >
      {children}
    </button>
  );
}

function StatusDot({ tone }: { tone: "live" | "fail" }) {
  return (
    <span
      aria-hidden
      className={`h-1.5 w-1.5 shrink-0 rounded-full ${
        tone === "fail" ? "bg-fail" : "bg-live pane-live"
      }`}
    />
  );
}

function ConversationBubble({ event }: { event: ConversationEvent }) {
  if (event.role === "assistant") {
    return (
      <p className="rise-in max-w-2xl text-[15px] leading-relaxed whitespace-pre-wrap text-text">
        {event.text}
      </p>
    );
  }

  if (event.role === "tool") {
    return (
      <div className="rise-in flex max-w-2xl items-start gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-xs text-muted">
        <Wrench size={13} className="mt-0.5 shrink-0 text-faint" />
        <span className="font-mono break-all">{event.text}</span>
      </div>
    );
  }

  if (event.role === "error") {
    return (
      <p className="rise-in max-w-2xl rounded-lg border border-fail/40 bg-fail/10 px-3 py-2 text-xs text-fail">
        {event.text}
      </p>
    );
  }

  return (
    <p className="rise-in font-mono text-[11px] tracking-wide text-faint uppercase">
      {event.text}
    </p>
  );
}

function ConversationView({
  job,
  onBack,
  conversation,
  conversationError,
}: {
  job: Job;
  onBack: () => void;
  conversation: ConversationEvent[];
  conversationError: string | null;
}) {
  const Icon = kindIcon[job.kind];
  const tone = statusTone(job.status);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [conversation.length]);

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-4 md:px-8">
          <button
            type="button"
            onClick={onBack}
            aria-label="Job一覧へ戻る"
            className="-ml-1 rounded-md p-1.5 text-muted transition-colors hover:bg-surface-hover hover:text-text md:hidden"
          >
            <ArrowLeft size={16} />
          </button>
          <Icon size={17} className="hidden md:block" />
          <div className="min-w-0">
            <p className="font-display text-base text-text">
              {kindLabel[job.kind]}
            </p>
            <p className="font-mono text-xs text-faint">{job.jobId}</p>
          </div>
          <div className="ml-auto flex items-center gap-2 font-mono text-xs text-muted">
            <StatusDot tone={tone} />
            {job.status ?? "unknown"}
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-8 py-6">
          {job.kind === "issue_conversation" && (
            <div className="flex h-[60vh] flex-col items-center justify-center gap-2 text-center">
              <MessageCircle size={28} className="text-faint" />
              <p className="max-w-sm text-sm text-muted">
                このJob種別はGitHub
                Issueへ返答を投稿するだけで、Agentは呼ばれず対話ログは記録されません。
              </p>
            </div>
          )}

          {job.kind !== "issue_conversation" && (
            <>
              {conversationError !== null && (
                <p role="alert" className="text-sm text-fail">
                  読み込みに失敗しました: {conversationError}
                </p>
              )}
              {conversationError === null && conversation.length === 0 && (
                <div className="flex h-[60vh] flex-col items-center justify-center gap-3 text-center text-muted">
                  <Loader2 size={20} className="animate-spin text-faint" />
                  <p className="text-sm">ログを待っています…</p>
                </div>
              )}
              {conversation.length > 0 && (
                <ol className="flex flex-col gap-4">
                  {conversation.map((event) => (
                    <li key={event.key}>
                      <ConversationBubble event={event} />
                    </li>
                  ))}
                </ol>
              )}
              {conversation.length > 0 && <div ref={bottomRef} aria-hidden />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function EmptyMain() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-8 text-center">
      <div className="opacity-70">
        <Logo />
      </div>
      <div>
        <h1 className="font-display text-2xl text-text">
          {identity.displayName}
        </h1>
        <p className="mx-auto mt-2 max-w-sm text-sm text-muted">
          左のJob一覧から選ぶと、実行ログがここに流れます。新しい対話や実装Jobは「新規」から始められます。
        </p>
      </div>
    </div>
  );
}

function NewJobModal({
  csrfToken,
  onClose,
  onStarted,
}: {
  csrfToken: string | null;
  onClose: () => void;
  onStarted: () => Promise<void>;
}) {
  const [kind, setKind] = useState<"issue" | "linear" | "implementation">(
    "issue",
  );
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    document.addEventListener("keydown", onKeyDown);

    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (csrfToken === null) {
      return;
    }

    const form = new FormData(event.currentTarget);
    const path =
      kind === "issue"
        ? "/api/issue-conversations"
        : kind === "linear"
          ? "/api/how-conversations"
          : "/api/implementation-jobs";
    const payload =
      kind === "issue"
        ? {
            issueNumber: Number(form.get("issueNumber")),
            body: String(form.get("body") ?? ""),
          }
        : kind === "linear"
          ? {
              issueNumber: Number(form.get("issueNumber")),
              linearIssueId: String(form.get("linearIssueId") ?? ""),
              body: String(form.get("body") ?? ""),
              command: form.get("command") === "on",
            }
          : { linearIssueId: String(form.get("linearIssueId") ?? "") };

    setPending(true);

    const { ok, body } = await postJson(path, csrfToken, payload);

    setPending(false);

    if (!ok) {
      setFormError(JSON.stringify(body));
      return;
    }

    await onStarted();
    onClose();
  }

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-10 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="新規Jobを始める"
        className="rise-in w-full max-w-md rounded-2xl border border-border bg-surface p-6 shadow-lg"
      >
        <div className="mb-5 flex items-center justify-between">
          <h2 className="font-display text-lg text-text">新規に始める</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="閉じる"
            className="rounded-md p-1 text-faint transition-colors hover:bg-surface-hover hover:text-text"
          >
            <X size={16} />
          </button>
        </div>

        <div className="mb-5 flex gap-1 rounded-lg border border-border bg-bg p-1">
          {(
            [
              { value: "issue", label: "Issue対話" },
              { value: "linear", label: "Linear対話" },
              { value: "implementation", label: "実装Job" },
            ] as const
          ).map((tab) => (
            <button
              key={tab.value}
              type="button"
              onClick={() => setKind(tab.value)}
              className={`flex-1 rounded-md px-3 py-1.5 text-sm transition-colors ${
                kind === tab.value
                  ? "bg-accent-soft text-accent"
                  : "text-muted hover:text-text"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <form onSubmit={submit} className="flex flex-col gap-4">
          {kind === "issue" && (
            <>
              <Field label="Issue番号">
                <input
                  name="issueNumber"
                  type="number"
                  required
                  min={1}
                  className={inputClass}
                  autoFocus
                />
              </Field>
              <Field label="返答本文">
                <textarea
                  name="body"
                  required
                  rows={4}
                  className={`${inputClass} resize-y`}
                />
              </Field>
            </>
          )}
          {kind === "linear" && (
            <>
              <Field label="Issue番号">
                <input
                  name="issueNumber"
                  type="number"
                  required
                  min={1}
                  className={inputClass}
                  autoFocus
                />
              </Field>
              <Field label="Triage中のLinear issue ID">
                <input
                  name="linearIssueId"
                  type="text"
                  required
                  className={inputClass}
                />
              </Field>
              <Field label="返答本文">
                <textarea
                  name="body"
                  required
                  rows={4}
                  className={`${inputClass} resize-y`}
                />
              </Field>
              <label className="flex items-center gap-2 text-sm text-muted">
                <input name="command" type="checkbox" />
                この回答でHOWの確定を求める(/oriel confirm相当)
              </label>
            </>
          )}
          {kind === "implementation" && (
            <Field label="承認済みLinear issue ID">
              <input
                name="linearIssueId"
                type="text"
                required
                className={inputClass}
                autoFocus
              />
            </Field>
          )}

          {formError !== null && (
            <p role="alert" className="text-xs text-fail">
              開始に失敗しました: {formError}
            </p>
          )}

          <PrimaryButton disabled={csrfToken === null || pending}>
            {pending && <Loader2 size={14} className="animate-spin" />}
            開始する
          </PrimaryButton>
        </form>
      </div>
    </div>
  );
}

export function App() {
  const [csrfToken, setCsrfToken] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [conversation, setConversation] = useState<ConversationEvent[]>([]);
  const [conversationError, setConversationError] = useState<string | null>(
    null,
  );
  const [newModalOpen, setNewModalOpen] = useState(false);
  const [filterQuery, setFilterQuery] = useState("");

  async function refreshJobs() {
    const response = await fetch("/api/jobs");

    if (!response.ok) {
      throw new Error(`status ${response.status}`);
    }

    const body = (await response.json()) as { jobs: Job[] };
    setJobs(body.jobs);
  }

  useEffect(() => {
    let cancelled = false;

    fetch("/app/session")
      .then((response) => {
        if (!response.ok) {
          throw new Error(`status ${response.status}`);
        }

        return response.json() as Promise<{ csrfToken: string }>;
      })
      .then((session) => {
        if (!cancelled) {
          setCsrfToken(session.csrfToken);
        }

        return refreshJobs();
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      });

    // 選択中のJobが完了して一覧から消えたことを検知できるよう、Job一覧自体も
    // ポーリングする。
    const interval = setInterval(() => {
      void refreshJobs().catch(() => undefined);
    }, 3_000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (selectedJobId === null) {
      return;
    }

    let cancelled = false;

    async function poll() {
      const response = await fetch(
        `/api/transcripts?scope=job&jobId=${encodeURIComponent(selectedJobId!)}&limit=200`,
      );

      if (!response.ok) {
        if (!cancelled) {
          setConversationError(`status ${response.status}`);
        }

        return;
      }

      const body = (await response.json()) as { entries: TranscriptEntry[] };
      const events = body.entries
        .slice()
        .sort((left, right) => left.sequence - right.sequence)
        .map(parseTranscriptEvent)
        .filter((event): event is ConversationEvent => event !== null);

      if (!cancelled) {
        setConversationError(null);
        setConversation(events);
      }
    }

    void poll();

    // Jobが一覧から消えたら(完了/失敗して片付いた)、それ以上ポーリングしない。
    const stillRunning =
      jobs?.some((job) => job.jobId === selectedJobId) ?? true;

    if (!stillRunning) {
      return () => {
        cancelled = true;
      };
    }

    const interval = setInterval(() => void poll(), 1_500);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [selectedJobId, jobs]);

  function selectJob(jobId: string) {
    setSelectedJobId(jobId);
    setConversation([]);
    setConversationError(null);
  }

  const selectedJob = jobs?.find((job) => job.jobId === selectedJobId) ?? null;
  const filteredJobs = (jobs ?? []).filter((job) => {
    const needle = filterQuery.trim().toLowerCase();

    return (
      needle === "" ||
      job.jobId.toLowerCase().includes(needle) ||
      kindLabel[job.kind].toLowerCase().includes(needle)
    );
  });

  return (
    <div className="flex h-dvh bg-bg text-text">
      <aside
        className={`${selectedJobId !== null ? "hidden md:flex" : "flex"} w-full shrink-0 flex-col border-r border-border bg-sidebar md:w-72`}
      >
        <div className="flex items-center gap-2 px-4 pt-4 pb-3">
          <Logo />
          <span className="font-display text-base text-text">
            {identity.displayName}
          </span>
        </div>

        <div className="px-4 pb-3">
          <button
            type="button"
            onClick={() => setNewModalOpen(true)}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-sidebar shadow-sm transition-all hover:bg-accent-hover active:scale-[0.98]"
          >
            <Plus size={15} />
            新規に始める
          </button>
        </div>

        <div className="px-4 pb-3">
          <div className="relative">
            <Search
              size={14}
              className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-faint"
            />
            <input
              type="text"
              value={filterQuery}
              onChange={(event) => setFilterQuery(event.target.value)}
              placeholder="Jobを検索"
              className="w-full rounded-lg border border-border bg-bg py-1.5 pr-3 pl-8 text-sm text-text placeholder:text-faint transition-colors focus:border-accent focus:outline-none"
            />
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto px-2 pb-2">
          <p className="px-2 pt-1 pb-1.5 font-mono text-[11px] tracking-[0.15em] text-faint uppercase">
            Workflow
          </p>

          {jobs === null && error === null && (
            <p className="px-2 py-2 text-sm text-muted">読み込み中…</p>
          )}
          {jobs !== null && filteredJobs.length === 0 && (
            <p className="px-2 py-2 text-sm text-muted">
              {jobs.length === 0
                ? "実行中のJobはありません。"
                : "一致するJobがありません。"}
            </p>
          )}

          <ul className="flex flex-col gap-0.5">
            {filteredJobs.map((job) => {
              const Icon = kindIcon[job.kind];
              const tone = statusTone(job.status);
              const selected = job.jobId === selectedJobId;

              return (
                <li key={job.jobId} className="relative">
                  {selected && (
                    <span
                      aria-hidden
                      className="absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-full bg-accent"
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => selectJob(job.jobId)}
                    aria-current={selected}
                    className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${
                      selected
                        ? "bg-accent-soft text-text"
                        : "text-muted hover:bg-surface-hover hover:text-text"
                    }`}
                  >
                    <Icon
                      size={15}
                      className={selected ? "text-accent" : "shrink-0"}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">
                        {kindLabel[job.kind]}
                      </span>
                      <span className="block truncate font-mono text-[11px] text-faint">
                        {job.jobId}
                      </span>
                    </span>
                    <StatusDot tone={tone} />
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="flex items-center gap-2 border-t border-border px-4 py-3 font-mono text-xs text-faint">
          <StatusDot tone={error === null ? "live" : "fail"} />
          {error === null ? "connected" : "接続失敗"}
        </div>
      </aside>

      <main
        className={`${selectedJob === null ? "hidden md:block" : "block"} min-w-0 flex-1`}
      >
        {selectedJob === null && <EmptyMain />}
        {selectedJob !== null && (
          <ConversationView
            job={selectedJob}
            onBack={() => setSelectedJobId(null)}
            conversation={conversation}
            conversationError={conversationError}
          />
        )}
      </main>

      {newModalOpen && (
        <NewJobModal
          csrfToken={csrfToken}
          onClose={() => setNewModalOpen(false)}
          onStarted={refreshJobs}
        />
      )}
    </div>
  );
}
