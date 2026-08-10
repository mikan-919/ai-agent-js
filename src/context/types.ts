/**
 * A source is "unavailable" when its credential is missing or the lookup
 * legitimately found nothing (e.g. no PR yet for this branch) — either way
 * resolveWorkContext must not throw, it just reports why.
 */
export type SourceResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: string };

export interface GitDiffFileStat {
  path: string;
  insertions: number;
  deletions: number;
  binary: boolean;
}

export interface GitContext {
  branch: string;
  mainBranch: string;
  diff: {
    files: GitDiffFileStat[];
    filesChanged: number;
    insertions: number;
    deletions: number;
  };
}

export interface GithubIssueRef {
  number: number;
  title: string;
  state: string;
  url: string;
}

export interface GithubContext {
  owner: string;
  repo: string;
  pullRequest: {
    number: number;
    title: string;
    state: string;
    isDraft: boolean;
    url: string;
    body: string | null;
    headRefName: string;
    baseRefName: string;
  } | null;
  linkedIssues: GithubIssueRef[];
}

export interface LinearContext {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  state: {
    name: string;
    type: string;
  };
  team: {
    key: string;
    name: string;
  };
}

export interface DocsContext {
  concept: string | null;
  roadmap: string | null;
  feature: string | null;
  handoff: string | null;
  /**
   * Names of watched docs (currently CONCEPT.md, ROADMAP.md) that differ
   * between branch HEAD and main HEAD — i.e. the version embedded in this
   * WorkContext may not match what main currently says. Empty when none
   * drifted.
   */
  driftedAgainstMain: string[];
}

export interface WorkContext {
  git: GitContext;
  github: SourceResult<GithubContext>;
  linear: SourceResult<LinearContext>;
  docs: DocsContext;
}
