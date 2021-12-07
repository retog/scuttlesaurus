//https://deno.land/x/scuttlesaurus@0.1.0/
import { Context } from "https://deno.land/x/oak@v10.0.0/context.ts";
import { createScuttlebuttHost } from "../scuttlesaurus/main.ts";
import { loadIntoGraph } from "./import.ts";

const host = await createScuttlebuttHost();
loadIntoGraph(host.feedsAgent!);
host.controlAppRouter!.get("/query", (ctx: Context) => ctx.response.body = "TODO: Query proxy");
host.start();
