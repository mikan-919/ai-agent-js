import { Hono } from "hono";

const loopbackHostname = "127.0.0.1";
const readinessPath = "/healthz";

export function startReadinessServer() {
  let expectedAuthority = "";
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

  app.get(readinessPath, (context) => context.json({ status: "ok" }));

  const server = Bun.serve({
    hostname: loopbackHostname,
    port: 0,
    fetch: app.fetch,
  });
  expectedAuthority = `${loopbackHostname}:${server.port}`;

  return {
    readinessUrl: new URL(`http://${expectedAuthority}${readinessPath}`),
    server,
  };
}
