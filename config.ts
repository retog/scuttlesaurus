import { path } from "./util.ts";

const baseDir = path.join(Deno.env.get("HOME")!, ".ssb/");
const dataDir = path.join(baseDir, "data/");

const config = {
  baseDir,
  dataDir,
};

export default config;
