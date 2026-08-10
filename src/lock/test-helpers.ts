/**
 * Stands in for the slice of the GitHub REST API the lock manager touches.
 * Ref creation is the only op that matters for correctness: it is
 * implemented as a synchronous Map check-and-set, mirroring GitHub's
 * atomic "fails if the ref already exists" behavior.
 */
export function installFakeGithubLockApi(owner: string, repo: string) {
  const refs = new Map<string, string>();
  const commits = new Map<string, { message: string; committerDate: string }>();
  let shaCounter = 0;

  const base = `https://api.github.com/repos/${owner}/${repo}`;
  const json = (status: number, body: unknown) =>
    new Response(body === null ? null : JSON.stringify(body), { status });

  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (!url.startsWith(base)) throw new Error(`unexpected fetch to ${url}`);
    const path = url.slice(base.length);
    const method = (init?.method ?? "GET").toUpperCase();

    if (method === "GET" && /^\/commits\/[^/]+$/.test(path)) {
      return json(200, { sha: "branch-head-sha", commit: { tree: { sha: "branch-tree-sha" } } });
    }

    if (method === "POST" && path === "/git/commits") {
      const body = JSON.parse(String(init?.body));
      const sha = `commit-${++shaCounter}`;
      commits.set(sha, { message: body.message, committerDate: body.committer.date });
      return json(201, { sha });
    }

    if (method === "POST" && path === "/git/refs") {
      const body = JSON.parse(String(init?.body));
      const refKey = body.ref.replace(/^refs\//, "");
      if (refs.has(refKey)) return json(422, { message: "Reference already exists" });
      refs.set(refKey, body.sha);
      return json(201, { ref: body.ref, object: { sha: body.sha } });
    }

    const getRefMatch = path.match(/^\/git\/ref\/(.+)$/);
    if (method === "GET" && getRefMatch) {
      const sha = refs.get(getRefMatch[1]!);
      return sha ? json(200, { object: { sha } }) : json(404, { message: "Not Found" });
    }

    const deleteRefMatch = path.match(/^\/git\/refs\/(.+)$/);
    if (method === "DELETE" && deleteRefMatch) {
      const refKey = deleteRefMatch[1]!;
      if (!refs.has(refKey)) return json(404, { message: "Not Found" });
      refs.delete(refKey);
      return json(204, null);
    }

    const patchRefMatch = path.match(/^\/git\/refs\/(.+)$/);
    if (method === "PATCH" && patchRefMatch) {
      const refKey = patchRefMatch[1]!;
      if (!refs.has(refKey)) return json(404, { message: "Not Found" });
      const body = JSON.parse(String(init?.body));
      refs.set(refKey, body.sha);
      return json(200, { ref: `refs/${refKey}`, object: { sha: body.sha } });
    }

    const getCommitMatch = path.match(/^\/git\/commits\/([^/]+)$/);
    if (method === "GET" && getCommitMatch) {
      const commit = commits.get(getCommitMatch[1]!);
      return commit
        ? json(200, { message: commit.message, committer: { date: commit.committerDate } })
        : json(404, { message: "Not Found" });
    }

    throw new Error(`unhandled fake GitHub request: ${method} ${path}`);
  }) as typeof fetch;

  return () => {
    globalThis.fetch = original;
  };
}
