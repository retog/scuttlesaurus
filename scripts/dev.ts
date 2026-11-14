/**
 * Development loop: rebuilds the web client whenever a file under `web/src` or
 * `web/static` changes and runs the node (`main.ts`) with `--watch` alongside.
 *
 * @module
 */
import { debounce } from "@std/async";
import { dirname, fromFileUrl, join } from "@std/path";
import { build } from "./build.ts";

const root = join(dirname(fromFileUrl(import.meta.url)), "..");

await build({ minify: false });

const node = new Deno.Command(Deno.execPath(), {
  args: ["run", "-A", "--watch", "main.ts"],
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
}).spawn();

const rebuild = debounce(() => {
  build({ minify: false });
}, 150);

const watcher = Deno.watchFs([
  join(root, "web", "src"),
  join(root, "web", "static"),
]);

Deno.addSignalListener("SIGINT", () => {
  watcher.close();
  try {
    node.kill("SIGINT");
  } catch {
    // already gone
  }
  Deno.exit(0);
});

for await (const event of watcher) {
  if (event.kind === "access") continue;
  rebuild();
}
