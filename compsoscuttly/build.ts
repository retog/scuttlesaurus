import { path } from "../scuttlesaurus/util.ts";
import { bundle } from "https://deno.land/x/emit@0.2.0/mod.ts";

const encoder = new TextEncoder();

const result = await bundle(
  "../scuttlesaurus/BrowserScuttlebuttHost.ts",
);

const { code } = result;
const outDir = "js";
Deno.mkdirSync(outDir, { recursive: true });
Deno.writeTextFileSync(path.join(outDir, "scuttlebutt-host.js"), code);
console.log("All done");
