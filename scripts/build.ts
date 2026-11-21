/**
 * Builds the web client into `web/dist/`.
 *
 * - bundles `web/src/main.tsx` to `web/dist/assets/app.js` with `deno bundle`
 * - copies everything under `web/static/` to `web/dist/`
 *
 * Run with `deno task build`. `scripts/dev.ts` imports {@link build} too.
 *
 * @module
 */
import { copy, emptyDir, ensureDir } from "@std/fs";
import { dirname, fromFileUrl, join } from "@std/path";

const root = join(dirname(fromFileUrl(import.meta.url)), "..");
const web = join(root, "web");
const dist = join(web, "dist");

/** Result of one build run. */
export interface BuildResult {
  ok: boolean;
  /** Wall-clock duration in milliseconds. */
  ms: number;
}

/** Bundle the application and copy the static files. Never throws. */
export async function build(
  options: { minify?: boolean } = {},
): Promise<BuildResult> {
  const started = performance.now();
  const minify = options.minify ?? true;
  await emptyDir(dist);
  await ensureDir(join(dist, "assets"));
  await copy(join(web, "static"), dist, { overwrite: true });

  const args = [
    "bundle",
    "--platform",
    "browser",
    ...(minify ? ["--minify"] : []),
    "--sourcemap=linked",
    "--output",
    join(dist, "assets", "app.js"),
    join(web, "src", "main.tsx"),
  ];
  const { code, stderr } = await new Deno.Command(Deno.execPath(), {
    args,
    cwd: root,
    stdout: "inherit",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(stderr).trim();
  if (text) console.error(text);
  const ms = Math.round(performance.now() - started);
  if (code !== 0) {
    console.error(`build failed (exit ${code})`);
    return { ok: false, ms };
  }
  console.log(`built web/dist in ${ms} ms`);
  return { ok: true, ms };
}

if (import.meta.main) {
  const { ok } = await build();
  if (!ok) Deno.exit(1);
}
