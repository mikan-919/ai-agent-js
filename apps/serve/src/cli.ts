import packageManifest from "../../../package.json" with { type: "json" };

if (Bun.argv[2] === "--version") {
  console.log(packageManifest.version);
}
