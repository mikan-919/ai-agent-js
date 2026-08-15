import { writeFile as writeFileToDisk } from "node:fs/promises";
import { join } from "node:path";

import {
  parseCheckpointEvent,
  type CheckpointRequest,
  type ImplementationClientMessage,
  type ImplementationStartEvent,
} from "@mikan-919/oriel-contracts";
import { identity } from "@mikan-919/oriel-identity";

import type { ImplementationAgent, ImplementationAgentOutcome } from "./agent";
import type { LocalGit } from "./git";

export interface ImplementationTransport {
  write(message: ImplementationClientMessage): void | Promise<void>;
  read(): Promise<unknown>;
}

export interface VerificationRun {
  command: string[];
  ok: boolean;
  output: string;
}

export interface ImplementationOutcome {
  agent: ImplementationAgentOutcome;
  verification: VerificationRun[];
  verified: boolean;
  committed: boolean;
  headOid: string;
  checkpoint: "completed" | "rejected" | "skipped";
  checkpointRejection: string | null;
}

export interface ImplementationWorkerOptions {
  start: ImplementationStartEvent;
  transport: ImplementationTransport;
  git: LocalGit;
  /** 承認済みWHAT/HOWからworktree内のsourceを実際に編集するAgent loop。 */
  agent: ImplementationAgent;
  /** worktree内でbuildやtestを走らせる。credentialは渡さない。 */
  runCommand: (
    command: string[],
    cwd: string,
  ) => Promise<{ ok: boolean; output: string }>;
  writeFile?: (path: string, content: string) => Promise<void>;
}

/**
 * 実装worker。
 *
 * `serve`が封印したcanonicalブランチのworktreeだけを対象に、承認済みWHAT/HOWから
 * Agent loopでsourceを編集し、そのうえで検証、HANDOFF、commitをローカルで行う。
 * 外部への送信は`serve`のcheckpoint操作としてだけ要求する。credentialは持たず、
 * 遠隔Gitへ直接触れない。
 */
export async function runImplementationWorker({
  start,
  transport,
  git,
  agent,
  runCommand,
  writeFile = (path, content) => writeFileToDisk(path, content),
}: ImplementationWorkerOptions): Promise<ImplementationOutcome> {
  const worktree = start.worktreePath;
  const startingHead = await readHead(git, worktree);

  // 封印、引き継ぎ、または取り込み先の統合で確認した先端でなければ何も始めない。
  if (startingHead !== start.worktreeOid) {
    throw new Error(
      "the worktree is not at the canonical tip the approval sealed",
    );
  }

  // 承認済みWHAT/HOWからの実装。commitとcheckpointはこの後でharnessが行う。
  const agentOutcome = await agent.run(start);

  // 引き継いだ先端も未検証の作業途中成果として、検証を最初からやり直す。
  const verification: VerificationRun[] = [];

  for (const command of start.verification) {
    const run = await runCommand(command, worktree);

    verification.push({ command, ok: run.ok, output: run.output });

    if (!run.ok) {
      break;
    }
  }

  /**
   * 検証commandは取り込み先branchの`.oriel.yaml`だけを正本にする。一つも実行
   * していない状態をverified扱いにしない。
   */
  const verified =
    start.verification.length > 0 &&
    verification.length === start.verification.length &&
    verification.every((run) => run.ok);

  await writeFile(
    join(worktree, "HANDOFF.md"),
    handoff(start, verification, agentOutcome),
  );

  const committed = await commitWorkInProgress(git, worktree, verified);
  const headOid = await readHead(git, worktree);

  if (!committed || headOid === start.worktreeOid) {
    return {
      agent: agentOutcome,
      verification,
      verified,
      committed: false,
      headOid,
      checkpoint: "skipped",
      checkpointRejection: null,
    };
  }

  const request: CheckpointRequest = {
    type: "checkpoint.request",
    requestId: "checkpoint-1",
    jobId: start.jobId,
    jobLeaseId: start.jobLeaseId,
    branchLeaseId: start.branchLeaseId,
    approvalFingerprint: start.approvalFingerprint,
    canonicalBranch: start.canonicalBranch,
    expectedOid: start.canonicalOid,
    headOid,
    verified,
  };

  await transport.write(request);

  const accepted = parseCheckpointEvent(await transport.read());

  if (accepted.type !== "checkpoint.accepted") {
    return {
      agent: agentOutcome,
      verification,
      verified,
      committed: true,
      headOid,
      checkpoint: "rejected",
      checkpointRejection:
        accepted.type === "checkpoint.rejected" ? accepted.reason : "unknown",
    };
  }

  const outcome = parseCheckpointEvent(await transport.read());

  // 結果不明の再送はharnessではなく`serve`の収束規則が担う。
  return {
    agent: agentOutcome,
    verification,
    verified,
    committed: true,
    headOid,
    checkpoint:
      outcome.type === "checkpoint.completed" ? "completed" : "rejected",
    checkpointRejection:
      outcome.type === "checkpoint.rejected" ? outcome.reason : null,
  };
}

async function readHead(git: LocalGit, worktree: string): Promise<string> {
  const head = await git.run(["rev-parse", "HEAD"], worktree);

  if (!head.ok) {
    throw new Error("the worktree HEAD could not be read");
  }

  return head.stdout.trim();
}

/** 作業ツリーに差分がある場合だけcommitする。 */
async function commitWorkInProgress(
  git: LocalGit,
  worktree: string,
  verified: boolean,
): Promise<boolean> {
  const staged = await git.run(["add", "-A"], worktree);

  if (!staged.ok) {
    throw new Error("the worktree changes could not be staged");
  }

  const status = await git.run(["status", "--porcelain"], worktree);

  if (!status.ok) {
    throw new Error("the worktree status could not be read");
  }

  if (status.stdout.trim() === "") {
    return false;
  }

  const committed = await git.run(
    [
      "-c",
      `user.name=${identity.checkpointAuthor.name}`,
      "-c",
      `user.email=${identity.checkpointAuthor.email}`,
      "commit",
      "--quiet",
      "--no-verify",
      "-m",
      verified ? "checkpoint" : "checkpoint: WIP, verification failing",
    ],
    worktree,
  );

  if (!committed.ok) {
    throw new Error("the checkpoint commit failed");
  }

  return true;
}

/**
 * 別の実行環境がこの地点から再開するためのHANDOFF。
 *
 * 現在地、確定した判断、未解決点、次の一手だけを持つ追記しない文書とする。
 * 取得IDのような接続中だけ有効な運転状態はGitへ残さない。
 */
function handoff(
  start: ImplementationStartEvent,
  verification: VerificationRun[],
  agent: ImplementationAgentOutcome,
): string {
  const failing = verification.filter((run) => !run.ok);
  const pending = start.verification.slice(verification.length);
  const unresolved = [
    ...(agent.stopReason === "stop"
      ? []
      : [`- 未完了のAgent turn: 停止理由は\`${agent.stopReason}\``]),
    ...failing.map((run) => `- 失敗中の検証: \`${run.command.join(" ")}\``),
    ...pending.map((run) => `- 未実行の検証: \`${run.join(" ")}\``),
  ];

  return `# HANDOFF

このcheckpointは未検証の作業途中成果として引き継ぐ。引き継ぎ先は差分を読み、
検証を最初からやり直す。

## 現在地

- canonical branch: \`${start.canonicalBranch}\`
- 引き継いだ先端: ${start.adopted ? "既存ブランチ" : "封印直後の初回作成"}

## 確定した判断

### WHAT

${start.what.title}

${start.what.body}

### HOW

${start.how.title}

${start.how.description}

## 未解決点

${unresolved.length === 0 ? "- なし。全ての検証を通した。" : unresolved.join("\n")}

## 次の一手

${
  unresolved.length === 0
    ? "- HOWの残りを実装し、検証を通してからHANDOFF.mdを消す。"
    : "- 上の検証を通してから次の区切りへ進む。"
}
`;
}
