// Transpile each plugin's index.ts to dist/index.js.
//
// OpenClaw (verified on 2026.7.1) loads TypeScript entries directly only for
// source checkouts and link-installs; `openclaw plugins install <tarball>`
// requires compiled runtime output next to the TS entry (./dist/index.js is
// the first candidate it probes). So packages ship both: index.ts as the
// readable source of truth, dist/index.js as what actually runs.
import { build } from "esbuild";
import { existsSync, readdirSync } from "node:fs";

for (const id of readdirSync("plugins")) {
  const entry = `plugins/${id}/index.ts`;
  if (!existsSync(entry)) continue;
  await build({
    entryPoints: [entry],
    outfile: `plugins/${id}/dist/index.js`,
    format: "esm",
    platform: "node",
    target: "es2022",
    bundle: false,
  });
  console.log(`built ${entry} -> plugins/${id}/dist/index.js`);
}
