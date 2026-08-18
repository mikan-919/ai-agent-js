import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import type {
  DeviceRegistrationPurpose,
  TranscriptEntry,
} from "@mikan-919/oriel-contracts";
import { identity } from "@mikan-919/oriel-identity";
import { Hono, type Context } from "hono";
import { serveStatic } from "hono/bun";

import type { DeviceRegistrationFlow } from "./device-registration";
import {
  createJobRegistry,
  type JobRegistry,
  type StartedJob,
} from "./job-registry";

/** 起動できたJobの取り扱い。開始結果を捨てず、終了まで面倒を見る。 */
export interface StartedIssueConversation extends StartedJob {
  status: "started";
}

function isStarted(
  value: StartedIssueConversation | { status: string; reason?: string },
): value is StartedIssueConversation {
  return value.status === "started";
}

function isTranscriptScope(
  value: string,
): value is "job" | "local" | "repository" {
  return value === "job" || value === "local" || value === "repository";
}

function isDeviceRegistrationPurpose(
  value: string,
): value is DeviceRegistrationPurpose {
  return (
    value === "installations" ||
    value === "registration" ||
    value === "device_list" ||
    value === "revocation"
  );
}

const loopbackHostname = "127.0.0.1";
const readinessPath = "/healthz";
const callbackPath = "/device/callback";
const webPath = "/app";
const sessionCookieName = `${identity.codeName}_session`;
const csrfHeaderName = `x-${identity.codeName}-csrf`;
/** ビルド後は`dist/cli.js`と同じ`dist/`直下にVite buildの`web/`が並ぶ。 */
const defaultWebDistRoot = fileURLToPath(new URL("./web", import.meta.url));

export interface ServeHttpServerOptions {
  /** localhost UIがdevice登録と失効に使う経路。relayの設定が無ければ配線しない。 */
  createDeviceRegistration?: (redirectUri: URL) => DeviceRegistrationFlow;
  /** Web UIのビルド成果物を置くディレクトリ。既定はビルド後の`dist/web`。 */
  webDistRoot?: string;
  /**
   * Workflow/Job一覧の唯一の正本。discoveryLoopなどHTTPを経由しない起動経路と
   * 共有できるよう、既定では内部で新しく作らず外部から注入できるようにする。
   */
  jobRegistry?: JobRegistry;
  /**
   * 明示的に起動する、コードを変更しないIssue対話。relay所有権を取れた場合だけ
   * workerが動く。
   */
  startIssueConversation?: (input: {
    issueNumber: number;
    body: string;
  }) => Promise<StartedIssueConversation | { status: string; reason?: string }>;
  /**
   * コードを変更する実装Job。入力は承認されたHOWのLinear Issueだけとし、WHAT、
   * Jobキー、canonicalブランチ、作業内容はすべて`serve`が現在値から導く。
   */
  startImplementationJob?: (input: {
    linearIssueId: string;
  }) => Promise<StartedIssueConversation | { status: string; reason?: string }>;
  /**
   * 明示的に起動する、コードを変更しないLinear対話。人間が書いた本文をLinear
   * commentとして投稿してからHOW確定Jobを始める。relay所有権を取れた場合だけ
   * workerが動く。
   */
  startHowConversation?: (input: {
    issueNumber: number;
    linearIssueId: string;
    body: string;
    command: boolean;
  }) => Promise<StartedIssueConversation | { status: string; reason?: string }>;
  /**
   * ROADMAPの「local、current Job、repositoryの範囲」を横断するtranscript検索。
   * `statePath`や`repository`が構成されていない起動では配線しない。
   */
  searchTranscripts?: (input: {
    scope: "job" | "local" | "repository";
    jobId?: string;
    query: string;
    limit: number;
  }) => Promise<TranscriptEntry[]>;
}

/** 起動ごとのsession値とCSRF token。永続化しない。 */
function newSessionSecrets() {
  return {
    sessionId: randomBytes(32).toString("base64url"),
    csrfToken: randomBytes(32).toString("base64url"),
  };
}

function shellHtml(csrfToken: string): string {
  return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="${identity.codeName}-csrf" content="${csrfToken}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${identity.displayName}</title>
    <style>
      :root { color-scheme: dark; }
      body {
        margin: 0;
        min-height: 100dvh;
        display: flex;
        align-items: center;
        justify-content: center;
        background: #201b16;
        color: #ede4d6;
        font-family: ui-sans-serif, system-ui, sans-serif;
        padding: 24px;
      }
      .card {
        width: 100%;
        max-width: 440px;
        border: 1px solid #3c332a;
        background: #2b241d;
        padding: 32px;
        border-radius: 16px;
        box-shadow: 0 24px 60px rgba(0, 0, 0, 0.35);
      }
      h1 {
        margin: 0 0 4px;
        font-family: Georgia, "Times New Roman", serif;
        font-size: 22px;
        font-weight: 500;
        letter-spacing: -0.01em;
      }
      .eyebrow {
        margin: 0 0 24px;
        font-family: ui-monospace, monospace;
        font-size: 11px;
        letter-spacing: 0.2em;
        text-transform: uppercase;
        color: #6f6255;
      }
      button {
        font: inherit;
        cursor: pointer;
        border-radius: 10px;
        transition: background-color 0.15s ease, border-color 0.15s ease;
      }
      .gate {
        border: none;
        background: #d97757;
        color: #17130f;
        padding: 10px 16px;
        font-weight: 500;
      }
      .gate:hover {
        background: #e28a6c;
      }
      select,
      #discover {
        font: inherit;
        border: 1px solid #3c332a;
        background: #201b16;
        color: #ede4d6;
        padding: 9px 12px;
        border-radius: 10px;
      }
      #discover {
        cursor: pointer;
      }
      #discover:hover {
        border-color: #d97757;
        color: #d97757;
      }
      form#target:not([hidden]) {
        display: flex;
        flex-direction: column;
        gap: 12px;
        margin-top: 16px;
      }
      label {
        display: flex;
        flex-direction: column;
        gap: 6px;
        font-size: 13px;
        color: #a89a89;
      }
      ul {
        list-style: none;
        padding: 0;
        margin: 20px 0 0;
        display: flex;
        flex-direction: column;
        gap: 1px;
        background: #3c332a;
        border-radius: 10px;
        overflow: hidden;
      }
      ul:empty {
        display: none;
      }
      li {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        background: #2b241d;
        padding: 10px 14px;
        font-family: ui-monospace, monospace;
        font-size: 13px;
      }
      li button {
        border: 1px solid #3c332a;
        background: transparent;
        color: #c1554a;
        padding: 4px 10px;
        font-size: 12px;
      }
      pre {
        margin-top: 20px;
        padding: 14px;
        background: #201b16;
        border: 1px solid #3c332a;
        border-radius: 10px;
        font-family: ui-monospace, monospace;
        font-size: 12px;
        overflow-x: auto;
        color: #a89a89;
      }
      pre:empty {
        display: none;
      }
      :focus-visible {
        outline: 2px solid #d97757;
        outline-offset: 2px;
      }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>${identity.displayName}</h1>
      <p class="eyebrow">device registration</p>
      <button id="discover" type="button">GitHubのinstallationを読み込む</button>
      <form id="target" hidden>
        <label>repository <select name="target" id="targets"></select></label>
        <button class="gate" type="submit" name="purpose" value="registration">このrepositoryへ登録</button>
        <button type="submit" name="purpose" value="device_list">deviceを一覧</button>
      </form>
      <ul id="devices"></ul>
      <pre id="result"></pre>
    </div>
    <script type="module">
      const csrf = document.querySelector('meta[name="${identity.codeName}-csrf"]').content;
      const show = (value) => {
        document.querySelector("#result").textContent = JSON.stringify(value, null, 2);
      };
      const post = (path, body) =>
        fetch(path, {
          method: "POST",
          headers: { "content-type": "application/json", "${csrfHeaderName}": csrf },
          body: JSON.stringify(body ?? {}),
        }).then((response) => response.json().catch(() => ({ status: response.status })));
      const start = async (body) => {
        const started = await post("/api/device-registrations", body);
        if (started.authorizeUrl) {
          window.location.href = started.authorizeUrl;
        } else {
          show(started);
        }
      };

      document.querySelector("#discover").addEventListener("click", () => {
        void start({ purpose: "installations" });
      });

      const showTargets = (installations) => {
        const targets = document.querySelector("#targets");
        targets.replaceChildren();
        for (const installation of installations) {
          for (const entry of installation.repositories) {
            const option = document.createElement("option");
            option.value = JSON.stringify({
              installationId: installation.installationId,
              repositoryId: entry.repositoryId,
            });
            option.textContent =
              entry.repository.owner + "/" + entry.repository.name +
              (installation.canAdminister ? "" : " (失効不可)");
            targets.append(option);
          }
        }
        document.querySelector("#target").hidden = installations.length === 0;
      };

      document.querySelector("#target").addEventListener("submit", (event) => {
        event.preventDefault();
        const selected = document.querySelector("#targets").value;
        if (selected) {
          void start({
            purpose: event.submitter.value,
            ...JSON.parse(selected),
          });
        }
      });

      const showDevices = (devices, target) => {
        const list = document.querySelector("#devices");
        list.replaceChildren();
        for (const device of devices) {
          const item = document.createElement("li");
          item.textContent =
            device.deviceId + (device.revokedAt === null ? "" : " (revoked)");
          if (device.revokedAt === null) {
            const button = document.createElement("button");
            button.textContent = "失効";
            button.addEventListener("click", () => {
              void start({ purpose: "revocation", deviceId: device.deviceId, ...target });
            });
            item.append(button);
          }
          list.append(item);
        }
      };

      const parameters = new URLSearchParams(window.location.search);
      if (parameters.has("code") && parameters.has("state")) {
        const completed = await post("/api/device-registrations/completion", {
          code: parameters.get("code"),
          state: parameters.get("state"),
        });
        show(completed);
        if (completed.status === "installations") {
          showTargets(completed.installations);
        }
        if (completed.status === "devices") {
          showDevices(completed.devices, {
            installationId: completed.installationId,
            repositoryId: completed.repositoryId,
          });
        }
      }
    </script>
  </body>
</html>
`;
}

export function startServeHttpServer({
  createDeviceRegistration,
  startIssueConversation,
  startImplementationJob,
  startHowConversation,
  searchTranscripts,
  webDistRoot = defaultWebDistRoot,
  jobRegistry = createJobRegistry(),
}: ServeHttpServerOptions = {}) {
  const { sessionId, csrfToken } = newSessionSecrets();
  let expectedAuthority = "";
  let deviceRegistration: DeviceRegistrationFlow | null = null;
  const app = new Hono();

  app.use("*", async (context, next) => {
    const host = context.req.header("host");
    const requestAuthority = new URL(context.req.url).host;
    const origin = context.req.header("origin");

    if (host !== expectedAuthority || requestAuthority !== expectedAuthority) {
      return context.text("Bad Request", 400);
    }

    if (origin !== undefined && origin !== `http://${expectedAuthority}`) {
      return context.text("Bad Request", 400);
    }

    context.header("X-Frame-Options", "DENY");
    await next();
  });

  // 状態を変える経路はsession cookieとCSRF token付きcustom headerを要求する。
  app.use("/api/*", async (context, next) => {
    const session = context.req
      .header("cookie")
      ?.split(";")
      .map((cookie) => cookie.trim())
      .find((cookie) => cookie.startsWith(`${sessionCookieName}=`))
      ?.slice(sessionCookieName.length + 1);

    if (session !== sessionId) {
      return context.text("Forbidden", 403);
    }

    if (
      context.req.method !== "GET" &&
      context.req.header(csrfHeaderName) !== csrfToken
    ) {
      return context.text("Forbidden", 403);
    }

    if (deviceRegistration === null) {
      return context.text("Device registration is not configured", 503);
    }

    await next();
  });

  app.get(readinessPath, (context) => context.json({ status: "ok" }));

  function serveShell(context: Context) {
    context.header(
      "Set-Cookie",
      `${sessionCookieName}=${sessionId}; HttpOnly; SameSite=Strict; Path=/`,
    );

    return context.html(shellHtml(csrfToken));
  }

  app.get("/", serveShell);
  // relayからの戻り先。GETは状態を変えず、UIが改めてPOSTで交換する。
  app.get(callbackPath, serveShell);

  app.post("/api/device-registrations", async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      installationId?: unknown;
      repositoryId?: unknown;
      purpose?: unknown;
      deviceId?: unknown;
    } | null;
    const purpose = body?.purpose;
    const installationId = Number(body?.installationId ?? 0);
    const repositoryId = Number(body?.repositoryId ?? 0);
    const deviceId = body?.deviceId;

    if (
      typeof purpose !== "string" ||
      !isDeviceRegistrationPurpose(purpose) ||
      (purpose !== "installations" &&
        (!Number.isInteger(installationId) ||
          installationId <= 0 ||
          !Number.isInteger(repositoryId) ||
          repositoryId <= 0)) ||
      (purpose === "revocation" &&
        (typeof deviceId !== "string" || deviceId === ""))
    ) {
      return context.text("Bad Request", 400);
    }

    const { authorizeUrl } = deviceRegistration!.begin({
      purpose,
      installationId,
      repositoryId,
      deviceId: typeof deviceId === "string" ? deviceId : undefined,
    });

    return context.json({ authorizeUrl: authorizeUrl.toString() });
  });

  app.post("/api/device-registrations/completion", async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      code?: unknown;
      state?: unknown;
    } | null;

    if (typeof body?.code !== "string" || typeof body.state !== "string") {
      return context.text("Bad Request", 400);
    }

    const callbackUrl = new URL(`http://${expectedAuthority}${callbackPath}`);
    callbackUrl.searchParams.set("code", body.code);
    callbackUrl.searchParams.set("state", body.state);

    return context.json(await deviceRegistration!.complete(callbackUrl));
  });

  /**
   * 起動できたJobをHTTPレスポンスへ変換する共通処理。
   *
   * Job registryへの登録は呼び出し元(`startIssueConversation`/
   * `startImplementationJob`自体)の責務とする。discoveryLoopなどHTTPを経由
   * しない起動経路も同じJob起動関数を呼ぶため、登録をここへ置くと二重登録に
   * なるか、HTTPを経由しない起動が一覧から漏れるかのどちらかになる。
   */
  async function holdStartedJob(
    context: Context,
    start: () => Promise<
      StartedIssueConversation | { status: string; reason?: string }
    >,
  ): Promise<Response> {
    const started = await start();

    if (!isStarted(started)) {
      return context.json(started, 409);
    }

    return context.json({
      status: "started",
      jobId: started.jobId,
    });
  }

  // コードを変更しない対話。WHATのIssueと人間が書いた返答本文だけを受け取る。
  app.post("/api/issue-conversations", async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      issueNumber?: unknown;
      body?: unknown;
    } | null;
    const issueNumber = Number(body?.issueNumber);

    // JobキーとcanonicalブランチはWHATの現在値からserveが導く。
    // clientはどちらも指定できず、この入口ではコードを変更するJobも起動できない。
    if (
      startIssueConversation === undefined ||
      body === null ||
      Object.keys(body).some(
        (field) => field !== "issueNumber" && field !== "body",
      ) ||
      typeof body.body !== "string" ||
      body.body === "" ||
      !Number.isInteger(issueNumber) ||
      issueNumber <= 0
    ) {
      return context.text("Bad Request", 400);
    }

    return holdStartedJob(context, () =>
      startIssueConversation({ issueNumber, body: body.body as string }),
    );
  });

  /**
   * コードを変更する実装Job。入力は承認されたHOWのLinear Issueだけとし、WHAT、
   * Jobキー、canonicalブランチ、承認指紋、作業内容はclientから受け取らない。
   */
  app.post("/api/implementation-jobs", async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      linearIssueId?: unknown;
    } | null;

    if (
      startImplementationJob === undefined ||
      body === null ||
      Object.keys(body).some((field) => field !== "linearIssueId") ||
      typeof body.linearIssueId !== "string" ||
      body.linearIssueId === ""
    ) {
      return context.text("Bad Request", 400);
    }

    return holdStartedJob(context, () =>
      startImplementationJob({ linearIssueId: body.linearIssueId as string }),
    );
  });

  /**
   * コードを変更しないLinear対話。JobキーとcanonicalブランチはHOWの現在値から
   * `serve`が導く。`command`はTriage→Todoの承認そのものではなく、Agentへ渡す
   * 確定意図の合図に過ぎない。
   */
  app.post("/api/how-conversations", async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      issueNumber?: unknown;
      linearIssueId?: unknown;
      body?: unknown;
      command?: unknown;
    } | null;
    const issueNumber = Number(body?.issueNumber);

    if (
      startHowConversation === undefined ||
      body === null ||
      Object.keys(body).some(
        (field) =>
          field !== "issueNumber" &&
          field !== "linearIssueId" &&
          field !== "body" &&
          field !== "command",
      ) ||
      typeof body.linearIssueId !== "string" ||
      body.linearIssueId === "" ||
      typeof body.body !== "string" ||
      body.body === "" ||
      !Number.isInteger(issueNumber) ||
      issueNumber <= 0 ||
      (body.command !== undefined && typeof body.command !== "boolean")
    ) {
      return context.text("Bad Request", 400);
    }

    return holdStartedJob(context, () =>
      startHowConversation({
        issueNumber,
        linearIssueId: body.linearIssueId as string,
        body: body.body as string,
        command: body.command === true,
      }),
    );
  });

  // Workflow/Jobの現在状態を横断的に確認する唯一の一覧経路。
  app.get("/api/jobs", (context) => context.json({ jobs: jobRegistry.list() }));

  // local、current Job、repositoryの範囲でtranscriptを確認する唯一の経路。
  app.get("/api/transcripts", async (context) => {
    if (searchTranscripts === undefined) {
      return context.text("Transcript search is not configured", 503);
    }

    const scope = context.req.query("scope");
    const jobId = context.req.query("jobId");
    // 省略時は空文字列。job scopeでは、あるJobの全ログを時系列に取り出す
    // 「一覧」としても`search`を使い、専用の一覧経路を別に持たない。
    const query = context.req.query("query") ?? "";
    const limit = Number(context.req.query("limit") ?? 50);

    if (
      typeof scope !== "string" ||
      !isTranscriptScope(scope) ||
      !Number.isInteger(limit) ||
      limit <= 0 ||
      limit > 200
    ) {
      return context.text("Bad Request", 400);
    }

    return context.json({
      entries: await searchTranscripts({ scope, jobId, query, limit }),
    });
  });

  // Workflow/Job一覧を確認するWeb UI。ビルド成果物をそのまま配信する。
  // deviceRegistrationの設定有無に関わらず、sessionとCSRF tokenだけを配る。
  app.get(`${webPath}/session`, (context) => {
    context.header(
      "Set-Cookie",
      `${sessionCookieName}=${sessionId}; HttpOnly; SameSite=Strict; Path=/`,
    );

    return context.json({ csrfToken });
  });
  app.get(webPath, (context) => context.redirect(`${webPath}/`, 302));
  app.use(
    `${webPath}/*`,
    serveStatic({
      root: webDistRoot,
      rewriteRequestPath: (path) => path.slice(webPath.length) || "/",
    }),
  );

  app.get("/api/device-cancellations", (context) =>
    context.json({ pending: deviceRegistration!.pendingCancellations() }),
  );

  app.post("/api/device-cancellations/resume", async (context) =>
    context.json({
      pending: await deviceRegistration!.resumePendingCancellations(),
    }),
  );

  const server = Bun.serve({
    hostname: loopbackHostname,
    port: 0,
    fetch: app.fetch,
  });
  expectedAuthority = `${loopbackHostname}:${server.port}`;
  deviceRegistration =
    createDeviceRegistration?.(
      new URL(`http://${expectedAuthority}${callbackPath}`),
    ) ?? null;

  return {
    readinessUrl: new URL(`http://${expectedAuthority}${readinessPath}`),
    server,
    jobRegistry,
    /** 停止時も動いているJobのprocessと所有権接続を閉じる。 */
    close() {
      jobRegistry.closeAll();
      server.stop(true);
    },
  };
}
