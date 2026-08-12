import packageManifest from "../../../package.json" with { type: "json" };

import { startReadinessServer } from "./server";

if (Bun.argv[2] === "--version") {
  console.log(packageManifest.version);
}

if (Bun.argv[2] === "serve") {
  const readinessServer = startReadinessServer();

  console.log(readinessServer.readinessUrl.toString());
}
