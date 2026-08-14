import { randomBytes } from "node:crypto";

import { identity } from "@mikan-919/oriel-identity";
import { Hono, type Context } from "hono";

import type { DeviceRegistrationFlow } from "./device-registration";

const loopbackHostname = "127.0.0.1";
const readinessPath = "/healthz";
const callbackPath = "/device/callback";
const sessionCookieName = `${identity.codeName}_session`;
const csrfHeaderName = `x-${identity.codeName}-csrf`;

export interface ServeHttpServerOptions {
  /** localhost UIがdevice登録と失効に使う経路。relayの設定が無ければ配線しない。 */
  createDeviceRegistration?: (redirectUri: URL) => DeviceRegistrationFlow;
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
    <title>${identity.displayName}</title>
  </head>
  <body>
    <h1>${identity.displayName} device</h1>
    <form id="start">
      <label>installation ID <input name="installationId" type="number" required /></label>
      <label>repository ID <input name="repositoryId" type="number" required /></label>
      <label>purpose
        <select name="purpose">
          <option value="registration">registration</option>
          <option value="management">management</option>
        </select>
      </label>
      <button type="submit">GitHubで続ける</button>
    </form>
    <ul id="devices"></ul>
    <pre id="result"></pre>
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

      document.querySelector("#start").addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = new FormData(event.target);
        const started = await post("/api/device-registrations", {
          installationId: Number(form.get("installationId")),
          repositoryId: Number(form.get("repositoryId")),
          purpose: form.get("purpose"),
        });
        if (started.authorizeUrl) {
          window.location.href = started.authorizeUrl;
        } else {
          show(started);
        }
      });

      const parameters = new URLSearchParams(window.location.search);
      if (parameters.has("code") && parameters.has("state")) {
        show(
          await post("/api/device-registrations/completion", {
            code: parameters.get("code"),
            state: parameters.get("state"),
          }),
        );
      }

      const listed = await fetch("/api/devices").then((response) =>
        response.ok ? response.json() : { devices: [] },
      );
      for (const device of listed.devices) {
        const item = document.createElement("li");
        item.textContent = device.deviceId + (device.revokedAt === null ? "" : " (revoked)");
        const button = document.createElement("button");
        button.textContent = "失効";
        button.addEventListener("click", async () => {
          show(await post("/api/devices/" + encodeURIComponent(device.deviceId) + "/revocation"));
        });
        item.append(button);
        document.querySelector("#devices").append(item);
      }
    </script>
  </body>
</html>
`;
}

export function startServeHttpServer({
  createDeviceRegistration,
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
    } | null;
    const installationId = Number(body?.installationId);
    const repositoryId = Number(body?.repositoryId);
    const purpose =
      body?.purpose === "management" ? "management" : "registration";

    if (
      !Number.isInteger(installationId) ||
      installationId <= 0 ||
      !Number.isInteger(repositoryId) ||
      repositoryId <= 0
    ) {
      return context.text("Bad Request", 400);
    }

    const { authorizeUrl } = deviceRegistration!.begin({
      installationId,
      repositoryId,
      purpose,
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

  app.get("/api/devices", async (context) => {
    const devices = await deviceRegistration!.listDevices();

    return devices === null
      ? context.text("A current management session is required", 409)
      : context.json({ devices });
  });

  app.post("/api/devices/:deviceId/revocation", async (context) => {
    const revoked = await deviceRegistration!.revokeDevice(
      context.req.param("deviceId"),
    );

    return revoked
      ? context.json({ status: "revoked" })
      : context.text("A current management session is required", 409);
  });

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
  };
}
