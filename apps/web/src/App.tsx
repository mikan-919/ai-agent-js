import { useEffect, useState } from "react";

interface Job {
  jobId: string;
  kind: "issue_conversation" | "implementation";
  status: string | null;
}

const kindLabel: Record<Job["kind"], string> = {
  issue_conversation: "Issue対話",
  implementation: "実装",
};

export function App() {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/jobs")
      .then((response) => {
        if (!response.ok) {
          throw new Error(`status ${response.status}`);
        }

        return response.json() as Promise<{ jobs: Job[] }>;
      })
      .then((body) => {
        if (!cancelled) {
          setJobs(body.jobs);
        }
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
    </main>
  );
}
