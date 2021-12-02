//https://deno.land/x/scuttlesaurus@0.1.0/
import { createScuttlebuttHost } from "../scuttlesaurus/main.ts";
import { loadIntoGraph } from "./import.ts";

const host = await createScuttlebuttHost();
loadIntoGraph(host.feedsAgent!);
host.start();
