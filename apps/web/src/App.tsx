import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  GitPullRequest,
  Hammer,
  HelpCircle,
  History,
  Loader2,
  MessageCircle,
  Plus,
  Route,
  Search,
  Settings,
  Square,
  Wrench,
  X,
} from "lucide-react";

import {
  modelDefaultKinds,
  parseInstanceConfig,
  parseModelOptions,
  parseServeConfig,
} from "@mikan-919/oriel-contracts";
import type {
  InstanceConfig,
  ModelDefaultApiSelection,
  ModelDefaultKind,
  ModelDefaultsDto,
  ModelOption as ModelOptionContract,
  ServeConfig,
  TranscriptEntry,
} from "@mikan-919/oriel-contracts";
import { identity } from "@mikan-919/oriel-identity";

const csrfHeaderName = `x-${identity.codeName}-csrf`;

function environmentVariable(name: string): string {
  return `${identity.environmentPrefix}${name}`;
}

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

type ModelKind = ModelDefaultKind;
type ModelSelection = ModelDefaultApiSelection;
type ModelDefaults = ModelDefaultsDto;
type ModelOption = ModelOptionContract;

const modelKindLabels: Record<ModelDefaultKind, string> = {
  what_confirmation: "WHAT確定",
  how_confirmation: "HOW確定",
  pr_response: "PR対応",
  implementation: "実装",
};
const modelKinds: readonly { kind: ModelKind; label: string }[] =
  modelDefaultKinds.map((kind) => ({ kind, label: modelKindLabels[kind] }));

function emptyModelDefaults(): ModelDefaults {
  return {
    base: null,
    perKind: Object.fromEntries(
      modelDefaultKinds.map((kind) => [kind, null]),
    ) as ModelDefaults["perKind"],
  };
}

/** relay origin、repositoryなど、初回起動時にWeb UIから入力するinstance設定。 */
type InstanceConfigFormField = keyof InstanceConfig;

const instanceConfigFields: {
  key: InstanceConfigFormField;
  label: string;
  env: string;
  required: boolean;
  type: "text" | "number";
}[] = [
  {
    key: "relayOrigin",
    label: "Relay origin",
    env: environmentVariable("RELAY_ORIGIN"),
    required: true,
    type: "text",
  },
  {
    key: "repositoryId",
    label: "Repository ID",
    env: environmentVariable("REPOSITORY_ID"),
    required: true,
    type: "number",
  },
  {
    key: "repositoryOwner",
    label: "Repository owner",
    env: environmentVariable("REPOSITORY_OWNER"),
    required: true,
    type: "text",
  },
  {
    key: "repositoryName",
    label: "Repository name",
    env: environmentVariable("REPOSITORY_NAME"),
    required: true,
    type: "text",
  },
  {
    key: "repositoryRoot",
    label: "Repository root",
    env: environmentVariable("REPOSITORY_ROOT"),
    required: true,
    type: "text",
  },
  {
    key: "worktreesRoot",
    label: "Worktrees root",
    env: environmentVariable("WORKTREES_ROOT"),
    required: true,
    type: "text",
  },
  {
    key: "linearTeamId",
    label: "Linear team ID",
    env: environmentVariable("LINEAR_TEAM_ID"),
    required: false,
    type: "text",
  },
  {
    key: "canonicalRemote",
    label: "Canonical remote",
    env: environmentVariable("CANONICAL_REMOTE"),
    required: false,
    type: "text",
  },
  {
    key: "lmStudioBaseUrl",
    label: "LM Studio base URL",
    env: environmentVariable("LM_STUDIO_BASE_URL"),
    required: false,
    type: "text",
  },
];

type InstanceConfigForm = Record<InstanceConfigFormField, string>;

function emptyInstanceConfigForm(): InstanceConfigForm {
  return Object.fromEntries(
    instanceConfigFields.map((field) => [field.key, ""]),
  ) as InstanceConfigForm;
}

function instanceConfigToForm(config: InstanceConfig): InstanceConfigForm {
  return Object.fromEntries(
    instanceConfigFields.map((field) => [
      field.key,
      config[field.key] === null ? "" : String(config[field.key]),
    ]),
  ) as InstanceConfigForm;
}

/** instance設定は未設定のフィールドが一つでもあれば、初回設定として扱う。 */
function isInstanceConfigComplete(config: InstanceConfig): boolean {
  return instanceConfigFields
    .filter((field) => field.required)
    .every((field) => config[field.key] !== null);
}

const kindLabel: Record<Job["kind"], string> = {
  issue_conversation: "Issue対話",
  implementation: "実装",
  what_confirmation: "WHAT確定",
  how_confirmation: "HOW確定",
  pr_response: "PR対応",
};

/**
 * `/api/jobs`は稼働中のJobしか返さないので、ログ検索の当たりは終了済みJobが
 * 大半になる。種別をnullにして「記録から開いたJob」として扱う。
 */
type SelectedJob = { kind: Job["kind"] | null } & Omit<Job, "kind">;

const finishedJobLabel = "記録から開いたJob";

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

/** 実行に時間がかかり、計画停止に応じるJob種別。 */
const stoppableKinds: Set<Job["kind"]> = new Set([
  "implementation",
  "pr_response",
]);

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

function getApiErrorMessage(body: unknown): string {
  if (
    typeof body === "object" &&
    body !== null &&
    "message" in body &&
    typeof body.message === "string" &&
    body.message !== ""
  ) {
    return body.message;
  }

  return "サーバーからエラーの詳細を取得できませんでした。";
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
  csrfToken,
  onBack,
  conversation,
  conversationError,
}: {
  job: SelectedJob;
  csrfToken: string | null;
  onBack: () => void;
  conversation: ConversationEvent[];
  conversationError: string | null;
}) {
  const Icon = job.kind === null ? History : kindIcon[job.kind];
  const tone = statusTone(job.status);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const [stopping, setStopping] = useState(false);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [conversation.length]);

  useEffect(() => {
    setStopping(false);
  }, [job.jobId]);

  async function stop() {
    if (csrfToken === null || stopping) {
      return;
    }

    setStopping(true);
    await postJson(
      `/api/jobs/${encodeURIComponent(job.jobId)}/stop`,
      csrfToken,
      {},
    );
  }

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
              {job.kind === null ? finishedJobLabel : kindLabel[job.kind]}
            </p>
            <p className="font-mono text-xs text-faint">{job.jobId}</p>
          </div>
          <div className="ml-auto flex items-center gap-3 font-mono text-xs text-muted">
            {job.kind !== null && stoppableKinds.has(job.kind) && (
              <button
                type="button"
                onClick={() => void stop()}
                disabled={csrfToken === null || stopping}
                className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-muted transition-colors hover:border-fail/50 hover:text-fail disabled:cursor-not-allowed disabled:opacity-40"
              >
                {stopping ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Square size={12} />
                )}
                {stopping ? "停止中…" : "停止"}
              </button>
            )}
            {/* 一覧に無いJobの状態は`serve`が持っていないので、稼働中に見える
                表示を作らず、記録を読んでいることだけを示す。 */}
            {job.kind === null ? (
              <span>記録のみ</span>
            ) : (
              <span className="flex items-center gap-2">
                <StatusDot tone={tone} />
                {job.status ?? "unknown"}
              </span>
            )}
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
              {conversationError === null &&
                conversation.length === 0 &&
                (job.kind === null ? (
                  <div className="flex h-[60vh] flex-col items-center justify-center gap-3 text-center text-muted">
                    <History size={20} className="text-faint" />
                    {/* ponytail: 検索結果はlocalと他serveの記録を混ぜて返すため、
                        他serveのJobもここへ来る。区別が要るなら検索結果に由来を
                        持たせる。 */}
                    <p className="text-sm">
                      この端末にはこのJobのログがありません。
                    </p>
                  </div>
                ) : (
                  <div className="flex h-[60vh] flex-col items-center justify-center gap-3 text-center text-muted">
                    <Loader2 size={20} className="animate-spin text-faint" />
                    <p className="text-sm">ログを待っています…</p>
                  </div>
                ))}
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
    const modelProvider = String(form.get("modelProvider") ?? "").trim();
    const modelId = String(form.get("modelId") ?? "").trim();

    if (
      kind === "implementation" &&
      (modelProvider === "") !== (modelId === "")
    ) {
      setFormError(
        "model providerとmodel IDのoverrideは両方入力するか、両方空欄にしてください。",
      );
      return;
    }

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
          : {
              linearIssueId: String(form.get("linearIssueId") ?? ""),
              ...(modelProvider === ""
                ? {}
                : { modelOverride: { provider: modelProvider, id: modelId } }),
            };

    setPending(true);

    const { ok, body } = await postJson(path, csrfToken, payload);

    setPending(false);

    if (!ok) {
      setFormError(getApiErrorMessage(body));
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
            <>
              <Field label="承認済みLinear issue ID">
                <input
                  name="linearIssueId"
                  type="text"
                  required
                  className={inputClass}
                  autoFocus
                />
              </Field>
              <div className="rounded-lg border border-border bg-bg p-3">
                <p className="text-sm text-text">Job単独override（任意）</p>
                <p className="mt-1 text-xs leading-relaxed text-muted">
                  空欄ならimplementationのper-kindまたはbase既定値を使います。この指定は保存されません。
                </p>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <Field label="Provider override">
                    <input
                      name="modelProvider"
                      type="text"
                      className={inputClass}
                      placeholder="provider"
                    />
                  </Field>
                  <Field label="Model ID override">
                    <input
                      name="modelId"
                      type="text"
                      className={inputClass}
                      placeholder="model ID"
                    />
                  </Field>
                </div>
              </div>
            </>
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

function ModelInput({
  provider,
  value,
  models,
  onChange,
}: {
  provider: string;
  value: string;
  models: ModelOption[];
  onChange: (value: string) => void;
}) {
  const providerModels = models.filter((model) => model.provider === provider);

  if (providerModels.length === 0) {
    return (
      <input
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="model IDを入力"
        className={inputClass}
      />
    );
  }

  const hasCurrentValue = providerModels.some((model) => model.id === value);

  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={inputClass}
    >
      <option value="">modelを選択</option>
      {value !== "" && !hasCurrentValue && (
        <option value={value}>{value}（現在値）</option>
      )}
      {providerModels.map((model) => (
        <option key={`${model.provider}/${model.id}`} value={model.id}>
          {model.name} · {model.id}
        </option>
      ))}
    </select>
  );
}

function ConfigModal({
  csrfToken,
  onClose,
}: {
  csrfToken: string | null;
  onClose: () => void;
}) {
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [instanceSaveError, setInstanceSaveError] = useState<string | null>(
    null,
  );
  const [instanceSavedMessage, setInstanceSavedMessage] = useState<
    string | null
  >(null);
  const [base, setBase] = useState<ModelSelection>({
    provider: "",
    modelId: "",
  });
  const [perKind, setPerKind] = useState<
    Record<ModelKind, ModelSelection | null>
  >(() => emptyModelDefaults().perKind);
  const [instanceForm, setInstanceForm] = useState<InstanceConfigForm>(
    emptyInstanceConfigForm(),
  );
  const queryClient = useQueryClient();
  const instanceConfigQuery = useQuery({
    queryKey: ["instance-config"],
    queryFn: async (): Promise<InstanceConfig> => {
      const response = await fetch("/api/instance-config");
      const body = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(getApiErrorMessage(body));
      }

      return parseInstanceConfig(body);
    },
  });
  const instanceConfig = instanceConfigQuery.data ?? null;
  const configQuery = useQuery({
    queryKey: ["serve-config"],
    queryFn: async (): Promise<ServeConfig> => {
      const response = await fetch("/api/config");
      const body = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(getApiErrorMessage(body));
      }

      return parseServeConfig(body);
    },
  });
  const modelsQuery = useQuery({
    queryKey: ["serve-models"],
    queryFn: async (): Promise<ModelOption[]> => {
      try {
        const response = await fetch("/api/models");
        const body = await response.json().catch(() => null);

        return response.ok ? parseModelOptions(body) : [];
      } catch {
        return [];
      }
    },
  });
  const config = configQuery.data ?? null;
  const models = modelsQuery.data ?? null;
  const error = configQuery.isError ? "設定を読み込めませんでした。" : null;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    document.addEventListener("keydown", onKeyDown);

    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    if (config === null) {
      return;
    }

    const defaults = config.modelDefaults;

    setBase(defaults.base ?? { provider: "", modelId: "" });
    setPerKind({
      ...emptyModelDefaults().perKind,
      ...defaults.perKind,
    });
  }, [config]);

  useEffect(() => {
    if (instanceConfig !== null) {
      setInstanceForm(instanceConfigToForm(instanceConfig));
    }
  }, [instanceConfig]);

  function updatePerKind(kind: ModelKind, value: ModelSelection | null) {
    setPerKind((current) => ({ ...current, [kind]: value }));
  }

  function selectionForSave(
    value: ModelSelection,
    label: string,
  ): ModelSelection | null {
    const provider = value.provider.trim();
    const modelId = value.modelId.trim();

    if (provider === "" && modelId === "") {
      return null;
    }

    if (provider === "" || modelId === "") {
      throw new Error(`${label}のproviderとmodel IDを両方入力してください。`);
    }

    return { provider, modelId };
  }

  const saveMutation = useMutation({
    mutationFn: async (
      updates: {
        scope: "base" | ModelKind;
        selection: ModelSelection | null;
      }[],
    ) => {
      if (csrfToken === null) {
        throw new Error("CSRF tokenがありません。");
      }

      for (const update of updates) {
        const result = await postJson("/api/config", csrfToken, {
          scope: update.scope,
          provider: update.selection?.provider ?? null,
          modelId: update.selection?.modelId ?? null,
        });

        if (!result.ok) {
          throw new Error(getApiErrorMessage(result.body));
        }
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["serve-config"] });
    },
  });

  const saveInstanceConfigMutation = useMutation({
    mutationFn: async (form: InstanceConfigForm) => {
      if (csrfToken === null) {
        throw new Error("CSRF tokenがありません。");
      }

      const payload = Object.fromEntries(
        instanceConfigFields.map((field) => {
          const raw = form[field.key].trim();

          if (raw === "") {
            return [field.key, null];
          }

          return [field.key, field.type === "number" ? Number(raw) : raw];
        }),
      );

      const result = await postJson("/api/instance-config", csrfToken, payload);

      if (!result.ok) {
        throw new Error(getApiErrorMessage(result.body));
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["instance-config"] });
      void queryClient.invalidateQueries({ queryKey: ["serve-config"] });
    },
  });

  async function saveInstanceConfig() {
    setInstanceSaveError(null);
    setInstanceSavedMessage(null);

    try {
      await saveInstanceConfigMutation.mutateAsync(instanceForm);
      setInstanceSavedMessage("保存しました。同じプロセスのまま反映します。");
    } catch (cause: unknown) {
      setInstanceSaveError(
        cause instanceof Error ? cause.message : String(cause),
      );
    }
  }

  async function save() {
    if (csrfToken === null) {
      return;
    }

    setSaveError(null);
    setSavedMessage(null);

    try {
      const updates: {
        scope: "base" | ModelKind;
        selection: ModelSelection | null;
      }[] = [
        { scope: "base", selection: selectionForSave(base, "base") },
        ...modelKinds.map(({ kind, label }) => ({
          scope: kind,
          selection:
            perKind[kind] === null
              ? null
              : selectionForSave(perKind[kind] as ModelSelection, label),
        })),
      ];

      await saveMutation.mutateAsync(updates);

      setSavedMessage("保存しました。");
    } catch (cause: unknown) {
      setSaveError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  // MODEL_PROVIDER/MODEL_IDはbase既定値のenv移行元に過ぎず、SQLiteが正本に
  // なった後もenv var自体はここでは編集できない読み取り専用表示のままとする。
  const envOnlyFields = [
    {
      label: "Model provider (env移行元)",
      env: environmentVariable("MODEL_PROVIDER"),
      value: config?.modelProviderId,
    },
    {
      label: "Model ID (env移行元)",
      env: environmentVariable("MODEL_ID"),
      value: config?.modelId,
    },
  ].filter((field) => field.value !== undefined);

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
        aria-label="設定を編集"
        className="rise-in max-h-[90dvh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-border bg-surface p-6 shadow-lg"
      >
        <div className="flex items-center justify-between">
          <h2 className="font-display text-lg text-text">設定</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="閉じる"
            className="rounded-md p-1 text-faint transition-colors hover:bg-surface-hover hover:text-text"
          >
            <X size={16} />
          </button>
        </div>

        <section className="mt-5 space-y-3">
          <div>
            <p className="font-mono text-[11px] tracking-[0.15em] text-faint uppercase">
              instance設定
            </p>
            <p className="mt-1 text-xs text-muted">
              relay
              origin、repositoryなどこのserve固有の設定です。保存すると再起動せずに反映されます。
            </p>
          </div>

          {instanceConfigQuery.isError && (
            <p role="alert" className="text-sm text-fail">
              instance設定を読み込めませんでした。
            </p>
          )}
          {instanceConfig === null && !instanceConfigQuery.isError && (
            <p className="text-sm text-muted">読み込み中…</p>
          )}

          {instanceConfig !== null && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void saveInstanceConfig();
              }}
              className="space-y-3"
            >
              <div className="grid gap-3 sm:grid-cols-2">
                {instanceConfigFields.map((field) => (
                  <Field
                    key={field.key}
                    label={`${field.label}${field.required ? "" : "（任意）"}`}
                  >
                    <input
                      type={field.type}
                      value={instanceForm[field.key]}
                      onChange={(event) =>
                        setInstanceForm((current) => ({
                          ...current,
                          [field.key]: event.target.value,
                        }))
                      }
                      placeholder={field.env}
                      className={inputClass}
                    />
                  </Field>
                ))}
              </div>

              {instanceSaveError !== null && (
                <p role="alert" className="text-xs text-fail">
                  保存に失敗しました: {instanceSaveError}
                </p>
              )}
              {instanceSavedMessage !== null && (
                <p role="status" className="text-xs text-muted">
                  {instanceSavedMessage}
                </p>
              )}

              <div className="flex justify-end">
                <PrimaryButton
                  disabled={
                    csrfToken === null || saveInstanceConfigMutation.isPending
                  }
                >
                  {saveInstanceConfigMutation.isPending && (
                    <Loader2 size={14} className="animate-spin" />
                  )}
                  instance設定を保存
                </PrimaryButton>
              </div>
            </form>
          )}

          {envOnlyFields.length > 0 && (
            <dl className="space-y-3">
              {envOnlyFields.map((field) => (
                <div
                  key={field.env}
                  className="rounded-lg border border-border bg-bg px-3 py-2"
                >
                  <dt className="flex items-baseline justify-between gap-3 text-xs text-muted">
                    <span>{field.label}</span>
                    <span className="font-mono text-[10px] text-faint">
                      {field.env}
                    </span>
                  </dt>
                  <dd className="mt-1 break-all font-mono text-sm text-text">
                    {String(field.value)}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </section>

        <div className="mt-6 border-t border-border pt-5">
          <p className="font-mono text-[11px] tracking-[0.15em] text-faint uppercase">
            モデル設定
          </p>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            baseを共通の既定値として、Job種別ごとに上書きできます。空のper-kind欄はbaseを使います。
          </p>
        </div>

        {config === null && error === null && (
          <p className="mt-5 text-sm text-muted">読み込み中…</p>
        )}
        {error !== null && (
          <p role="alert" className="mt-5 text-sm text-fail">
            {error}
          </p>
        )}
        {config !== null && (
          <>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
              className="mt-6 space-y-6"
            >
              <section className="space-y-3">
                <div>
                  <p className="font-mono text-[11px] tracking-[0.15em] text-faint uppercase">
                    base / instance default
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    全Job種別がper-kind overrideを持たない場合に使います。
                  </p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Provider">
                    <input
                      type="text"
                      value={base.provider}
                      onChange={(event) =>
                        setBase((current) => ({
                          ...current,
                          provider: event.target.value,
                        }))
                      }
                      placeholder="例: openai / lm-studio"
                      className={inputClass}
                    />
                  </Field>
                  <Field label="Model ID">
                    <ModelInput
                      provider={base.provider}
                      value={base.modelId}
                      models={models ?? []}
                      onChange={(modelId) =>
                        setBase((current) => ({ ...current, modelId }))
                      }
                    />
                  </Field>
                </div>
              </section>

              <section className="space-y-3">
                <div>
                  <p className="font-mono text-[11px] tracking-[0.15em] text-faint uppercase">
                    per-kind defaults
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    自動起動されるJobは、ここで指定したmodelをJob作成時に固定します。
                  </p>
                </div>
                <div className="space-y-3">
                  {modelKinds.map(({ kind, label }) => {
                    const override = perKind[kind];
                    const usesBase = override === null;

                    return (
                      <div
                        key={kind}
                        className="rounded-lg border border-border bg-bg px-3 py-3"
                      >
                        <label className="flex items-center gap-2 text-sm text-text">
                          <input
                            type="checkbox"
                            checked={usesBase}
                            onChange={(event) =>
                              updatePerKind(
                                kind,
                                event.target.checked
                                  ? null
                                  : (override ?? { ...base }),
                              )
                            }
                          />
                          <span>{label}</span>
                          <span className="text-xs text-muted">baseを使う</span>
                        </label>

                        {!usesBase && override !== null && (
                          <div className="mt-3 grid gap-3 sm:grid-cols-2">
                            <Field label="Provider override">
                              <input
                                type="text"
                                value={override.provider}
                                onChange={(event) =>
                                  updatePerKind(kind, {
                                    ...override,
                                    provider: event.target.value,
                                  })
                                }
                                placeholder="provider"
                                className={inputClass}
                              />
                            </Field>
                            <Field label="Model ID override">
                              <ModelInput
                                provider={override.provider}
                                value={override.modelId}
                                models={models ?? []}
                                onChange={(modelId) =>
                                  updatePerKind(kind, {
                                    ...override,
                                    modelId,
                                  })
                                }
                              />
                            </Field>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>

              {models === null && (
                <p className="text-xs text-muted">model一覧を読み込み中…</p>
              )}
              {models !== null && models.length === 0 && (
                <p className="text-xs text-muted">
                  model一覧を取得できないため、model IDを自由入力できます。
                </p>
              )}
              {saveError !== null && (
                <p role="alert" className="text-xs text-fail">
                  保存に失敗しました: {saveError}
                </p>
              )}
              {savedMessage !== null && (
                <p role="status" className="text-xs text-muted">
                  {savedMessage}
                </p>
              )}

              <div className="flex justify-end">
                <PrimaryButton
                  disabled={csrfToken === null || saveMutation.isPending}
                >
                  {saveMutation.isPending && (
                    <Loader2 size={14} className="animate-spin" />
                  )}
                  設定を保存
                </PrimaryButton>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

const transcriptScopes = [
  { value: "job", label: "このJob" },
  { value: "local", label: "この端末" },
  { value: "repository", label: "repository" },
] as const;

type TranscriptScope = (typeof transcriptScopes)[number]["value"];

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);

    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}

/** 検索結果の一行は、会話表示と同じ整形を通し、拾えない種別だけ生の内容へ落とす。 */
function transcriptSnippet(entry: TranscriptEntry): string {
  return parseTranscriptEvent(entry)?.text ?? entry.content;
}

/**
 * transcriptの全文検索。`job`と`local`はこの`serve`のSQLiteだけで完結し、
 * `repository`だけがrelay経由で同じrepositoryを担当する他の`serve`へ広がる。
 */
function TranscriptSearchResults({
  query,
  jobs,
  selectedJobId,
  onSelectJob,
}: {
  query: string;
  jobs: Job[];
  selectedJobId: string | null;
  onSelectJob: (jobId: string) => void;
}) {
  const [scope, setScope] = useState<TranscriptScope>("local");
  // Jobを選んでいないときにJob scopeを選ばせても結果が空になるだけなので、
  // 同じ端末の範囲へ落とす。
  const effectiveScope =
    scope === "job" && selectedJobId === null ? "local" : scope;
  const debouncedQuery = useDebounced(query.trim(), 250);
  const results = useQuery({
    queryKey: [
      "transcript-search",
      effectiveScope,
      effectiveScope === "job" ? selectedJobId : null,
      debouncedQuery,
    ],
    enabled: debouncedQuery !== "",
    queryFn: async (): Promise<TranscriptEntry[]> => {
      const params = new URLSearchParams({
        scope: effectiveScope,
        query: debouncedQuery,
        limit: "50",
      });

      if (effectiveScope === "job" && selectedJobId !== null) {
        params.set("jobId", selectedJobId);
      }

      const response = await fetch(`/api/transcripts?${params.toString()}`);

      if (!response.ok) {
        throw new Error(
          getApiErrorMessage(await response.json().catch(() => null)),
        );
      }

      const body = (await response.json()) as { entries: TranscriptEntry[] };

      return body.entries;
    },
  });
  const entries = results.data ?? null;

  if (debouncedQuery === "") {
    return null;
  }

  return (
    <section className="mt-4 border-t border-border pt-3">
      <p className="px-2 pb-1.5 font-mono text-[11px] tracking-[0.15em] text-faint uppercase">
        ログ検索
      </p>

      <div className="mx-2 mb-2 flex gap-1 rounded-lg border border-border bg-bg p-0.5">
        {transcriptScopes.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => setScope(option.value)}
            disabled={option.value === "job" && selectedJobId === null}
            className={`flex-1 rounded-md px-1.5 py-1 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
              effectiveScope === option.value
                ? "bg-accent-soft text-accent"
                : "text-muted hover:text-text"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      {results.isPending && (
        <p className="px-2 py-1.5 text-sm text-muted">検索中…</p>
      )}
      {results.isError && (
        <p role="alert" className="px-2 py-1.5 text-sm text-fail">
          {results.error.message}
        </p>
      )}
      {entries !== null && entries.length === 0 && (
        <p className="px-2 py-1.5 text-sm text-muted">
          一致するログはありません。
        </p>
      )}

      <ul className="flex flex-col gap-0.5">
        {(entries ?? []).map((entry) => {
          const job = jobs.find((candidate) => candidate.jobId === entry.jobId);

          return (
            <li key={`${entry.jobId}-${entry.sequence}`}>
              <button
                type="button"
                onClick={() => onSelectJob(entry.jobId)}
                className="w-full rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-surface-hover"
              >
                <span className="flex items-baseline gap-2">
                  <span className="truncate text-xs text-muted">
                    {job === undefined ? finishedJobLabel : kindLabel[job.kind]}
                  </span>
                  <span className="ml-auto shrink-0 font-mono text-[10px] text-faint">
                    {new Date(entry.createdAt).toLocaleString([], {
                      month: "2-digit",
                      day: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </span>
                <span className="mt-0.5 line-clamp-2 text-[13px] leading-snug break-all text-text">
                  {transcriptSnippet(entry)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
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
  const [configModalOpen, setConfigModalOpen] = useState(false);
  const [filterQuery, setFilterQuery] = useState("");

  async function refreshJobs() {
    const response = await fetch("/api/jobs");

    if (!response.ok) {
      throw new Error(`status ${response.status}`);
    }

    const body = (await response.json()) as { jobs: Job[] };
    setJobs(body.jobs);
    setError(null);
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

  // instance設定(relay origin、repositoryなど)が未完了の間は、初回設定として
  // 設定モーダルを自動的に開く。
  useEffect(() => {
    let cancelled = false;

    fetch("/api/instance-config")
      .then((response) => (response.ok ? response.json() : null))
      .then((body: unknown) => {
        if (cancelled || body === null) {
          return;
        }

        if (!isInstanceConfigComplete(parseInstanceConfig(body))) {
          setConfigModalOpen(true);
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
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

  const selectedJob: SelectedJob | null =
    selectedJobId === null
      ? null
      : (jobs?.find((job) => job.jobId === selectedJobId) ?? {
          jobId: selectedJobId,
          kind: null,
          status: null,
        });
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
          <button
            type="button"
            onClick={() => setConfigModalOpen(true)}
            aria-label="設定を編集"
            className="ml-auto rounded-md p-1.5 text-faint transition-colors hover:bg-surface-hover hover:text-text"
          >
            <Settings size={16} />
          </button>
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
              placeholder="Jobとログを検索"
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
          {jobs === null && error !== null && (
            <p role="alert" className="px-2 py-2 text-sm text-fail">
              Job一覧の読み込みに失敗しました。
            </p>
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

          <TranscriptSearchResults
            query={filterQuery}
            jobs={jobs ?? []}
            selectedJobId={selectedJobId}
            onSelectJob={selectJob}
          />
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
            csrfToken={csrfToken}
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
      {configModalOpen && (
        <ConfigModal
          csrfToken={csrfToken}
          onClose={() => setConfigModalOpen(false)}
        />
      )}
    </div>
  );
}
