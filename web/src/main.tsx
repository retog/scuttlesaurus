/**
 * Entry point of the web client.
 *
 * @module
 */
import { render } from "preact";
import { App } from "./app.tsx";
import { loadNode } from "./lib/node.ts";

render(<App />, document.getElementById("app")!);
loadNode();
