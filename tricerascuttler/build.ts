import { path } from "../scuttlesaurus/util.ts";

const encoder = new TextEncoder();
const { files } = await Deno.emit(
  "../scuttlesaurus/BrowserScuttlebuttHost.ts",
  {
    bundle: "module",
  },
);
const outDir = "static/common/js/ext";
Deno.mkdirSync(outDir, { recursive: true });
for (const [fileName, text] of Object.entries(files)) {
  const outFileName = fileName.substring("deno://".length).replace(
    "bundle",
    "scuttlebutt-host",
  );
  Deno.writeFileSync(
    path.join(outDir, outFileName),
    encoder.encode(text as string),
  );
}
console.log("All done");
