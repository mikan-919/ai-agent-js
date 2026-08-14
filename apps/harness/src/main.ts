import {
  createNdjsonIssueCommentOperationClient,
  postIssueConversationReply,
} from "./issue-conversation";

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

const [owner, name] = argument("repository").split("/");

if (owner === undefined || name === undefined) {
  throw new Error("--repository must be owner/name");
}

const decoder = new TextDecoder();
let buffer = "";
const pending: ((value: unknown) => void)[] = [];
const received: unknown[] = [];

// stdoutのNDJSONを読み、要求の対応付けだけをここで行う。
void (async () => {
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line === "") {
        continue;
      }

      const event = JSON.parse(line) as unknown;
      const resolve = pending.shift();

      if (resolve === undefined) {
        received.push(event);
      } else {
        resolve(event);
      }
    }
  }
})();

const operationClient = createNdjsonIssueCommentOperationClient({
  write(message) {
    Bun.stdout.write(`${JSON.stringify(message)}\n`);
  },
  read() {
    const buffered = received.shift();

    return buffered === undefined
      ? new Promise<unknown>((resolve) => pending.push(resolve))
      : Promise.resolve(buffered);
  },
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
