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
  // bundle:true so multi-file plugins (and any real deps) collapse into one
  // self-contained dist/index.js; node: builtins stay external via platform.
  // The openclaw SDK stays external too: it exists only inside the gateway,
  // which resolves it for loaded plugins (type-only imports erase anyway).
  await build({
    entryPoints: [entry],
    outfile: `plugins/${id}/dist/index.js`,
    format: "esm",
    platform: "node",
    target: "es2022",
    bundle: true,
    external: ["openclaw", "openclaw/*"],
  });
  console.log(`built ${entry} -> plugins/${id}/dist/index.js`);
}
