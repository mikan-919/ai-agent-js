import tailwindPlugin from "bun-plugin-tailwind";

const result = await Bun.build({
  entrypoints: ["./web/index.html"],
  outdir: "./dist/web",
  plugins: [tailwindPlugin],
  minify: true,
  target: "browser",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

for (const artifact of result.outputs) {
  console.log(`built ${artifact.path}`);
}
