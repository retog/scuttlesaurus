import { path } from "../scuttlesaurus/util.ts";
import { bundle } from "https://deno.land/x/emit@0.2.0/mod.ts";

const result = await bundle(
  "../scuttlesaurus/BrowserScuttlebuttHost.ts",
);

const { code, map } = result;
const outDir = "static/common/js/ext";
Deno.mkdirSync(outDir, { recursive: true });
Deno.writeTextFileSync(path.join(outDir, "scuttlebutt-host.js"), code);
if (map) {
  Deno.writeTextFileSync(path.join(outDir, "scuttlebutt-host.js.map"), map);
}
console.log("All done");
