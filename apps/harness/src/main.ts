import {
  parseImplementationStartEvent,
  type ImplementationClientMessage,
} from "@mikan-919/oriel-contracts";

import { createImplementationAgent } from "./agent";
import { systemLocalGit } from "./git";
import { runImplementationWorker } from "./implementation";
import { createHarnessMessageRouter } from "./ipc";
import {
  createNdjsonIssueCommentOperationClient,
  postIssueConversationReply,
} from "./issue-conversation";
import { createProxyStreamFn, type ModelStreamChannel } from "./model-channel";
import { createWorktreeTools } from "./worktree-tools";

/**
 * Job単位のharness process。credentialを持たず、`serve`が与えた対象と取得IDの
 * 範囲でだけ、`serve`の狭い外部操作を要求する。
 */
function argument(name: string): string {
  const flag = `--${name}`;
  const index = Bun.argv.indexOf(flag);
  const value = index < 0 ? undefined : Bun.argv[index + 1];

  if (value === undefined || value === "") {
    throw new Error(`${flag} is required`);
  }

  return value;
}

const decoder = new TextDecoder();
let buffer = "";
const router = createHarnessMessageRouter();

// stdinのNDJSONを読み、要求の対応付けだけをここで行う。
void (async () => {
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line !== "") {
        router.deliver(JSON.parse(line) as unknown);
      }
    }
  }

  // 切断は待ち続けるturnを残さない。
  router.close();
})();

function read(): Promise<unknown> {
  return router.read();
}

function write(message: unknown): number | Promise<number> {
  return Bun.stdout.write(`${JSON.stringify(message)}\n`);
}

const mode = Bun.argv.includes("--mode") ? argument("mode") : "issue";

const runCommand = async (command: string[], cwd: string) => {
  const [executable, ...args] = command;
  const spawned = Bun.spawn([executable!, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    // `serve`がharnessへ渡した時点でcredentialは含まれていない。
    env: { ...Bun.env },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(spawned.stdout).text(),
    new Response(spawned.stderr).text(),
    spawned.exited,
  ]);

  return { ok: exitCode === 0, output: `${stdout}${stderr}` };
};

if (mode === "implementation") {
  // 封印済みworktreeと承認済みWHAT/HOWだけをstart eventとして受け取る。
  const start = parseImplementationStartEvent(await read());
  // modelへの要求は`serve`のmodel stream操作へ中継する。credentialは持たない。
  const channel: ModelStreamChannel = {
    open(request) {
      const stream = router.open(request.requestId);

      write(request);

      return stream;
    },
    abort(requestId) {
      write({ type: "model.stream.abort", requestId });
    },
  };
  const outcome = await runImplementationWorker({
    start,
    transport: {
      // 結果messageを書き終えるまでprocessを終わらせない。
      write: async (message: ImplementationClientMessage) => {
        await write(message);
      },
      read,
    },
    git: systemLocalGit,
    agent: createImplementationAgent({
      streamFn: createProxyStreamFn({
        jobId: start.jobId,
        jobLeaseId: start.jobLeaseId,
        model: start.model,
        channel,
      }),
      tools: createWorktreeTools({
        worktreePath: start.worktreePath,
        runCommand,
      }),
    }),
    runCommand,
  });

  process.stderr.write(
    `implementation ${outcome.checkpoint} verified=${outcome.verified} agent=${outcome.agent.stopReason}\n`,
  );
  process.exit(outcome.checkpoint === "rejected" ? 1 : 0);
}

const [owner, name] = argument("repository").split("/");

if (owner === undefined || name === undefined) {
  throw new Error("--repository must be owner/name");
}

const operationClient = createNdjsonIssueCommentOperationClient({
  write: async (message) => {
    await write(message);
  },
  read,
});

await postIssueConversationReply(
  {
    requestId: argument("request"),
    jobId: argument("job"),
    jobLeaseId: argument("lease"),
    repository: { owner, name },
    issueNumber: Number(argument("issue")),
    body: argument("body"),
  },
  operationClient,
  (event) => {
    process.stderr.write(`${event.type}\n`);
  },
);

// 返答が完了したらJob processを終える。stdinのreaderで生き残らせない。
process.exit(0);
