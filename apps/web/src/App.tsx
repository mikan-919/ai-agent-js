import { useEffect, useState } from "react";

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

export function App() {
  const [csrfToken, setCsrfToken] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

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

    return () => {
      cancelled = true;
    };
  }, []);

  async function submitIssueConversation(
    event: React.FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();

    if (csrfToken === null) {
      return;
    }

    const form = new FormData(event.currentTarget);
    const { ok, body } = await postJson("/api/issue-conversations", csrfToken, {
      issueNumber: Number(form.get("issueNumber")),
      body: String(form.get("body") ?? ""),
    });

    if (!ok) {
      setFormError(JSON.stringify(body));
      return;
    }

    setFormError(null);
    event.currentTarget.reset();
    await refreshJobs();
  }

  async function submitImplementationJob(
    event: React.FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();

    if (csrfToken === null) {
      return;
    }

    const form = new FormData(event.currentTarget);
    const { ok, body } = await postJson("/api/implementation-jobs", csrfToken, {
      linearIssueId: String(form.get("linearIssueId") ?? ""),
    });

    if (!ok) {
      setFormError(JSON.stringify(body));
      return;
    }

    setFormError(null);
    event.currentTarget.reset();
    await refreshJobs();
  }

  return (
    <main>
      <h1>実行中のJob</h1>
      {error !== null && <p role="alert">読み込みに失敗しました: {error}</p>}
      {jobs === null && error === null && <p>読み込み中…</p>}
      {jobs !== null && jobs.length === 0 && <p>実行中のJobはありません。</p>}
      {jobs !== null && jobs.length > 0 && (
        <ul>
          {jobs.map((job) => (
            <li key={job.jobId}>
              {kindLabel[job.kind]} / {job.jobId} / {job.status ?? "unknown"}
            </li>
          ))}
        </ul>
      )}

      {formError !== null && (
        <p role="alert">開始に失敗しました: {formError}</p>
      )}

      <h2>Issue対話を始める</h2>
      <form onSubmit={submitIssueConversation}>
        <label>
          Issue番号
          <input name="issueNumber" type="number" required min={1} />
        </label>
        <label>
          返答本文
          <textarea name="body" required />
        </label>
        <button type="submit" disabled={csrfToken === null}>
          開始
        </button>
      </form>

      <h2>実装Jobを始める</h2>
      <form onSubmit={submitImplementationJob}>
        <label>
          承認済みLinear issue ID
          <input name="linearIssueId" type="text" required />
        </label>
        <button type="submit" disabled={csrfToken === null}>
          開始
        </button>
      </form>
    </main>
  );
}
