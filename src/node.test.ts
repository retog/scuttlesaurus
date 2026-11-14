import { assertEquals, assertStringIncludes } from "@std/assert";
import { term } from "./vocab.ts";
import { startNode } from "./node.ts";
import { newSigner, signEvent } from "./http/test_helpers.ts";

Deno.test("a started node serves status, NIP-11, the relay and SPARQL", async () => {
  const owner = newSigner();
  const dataDir = await Deno.makeTempDir({ prefix: "scuttle-node-" });
  const running = await startNode({
    DATA_DIR: dataDir,
    PORT: "0",
    REPLICATION: "off",
    OWNER: owner.pubkey,
  });
  try {
    assertEquals(running.port > 0, true);
    assertStringIncludes(running.url, `:${running.port}`);

    const status = await fetch(`${running.url}/api/status`);
    assertEquals(status.status, 200);
    const document = await status.json();
    assertEquals(document.owner, owner.pubkey);
    assertEquals(document.setupRequired, false);

    const info = await fetch(`${running.url}/`, {
      headers: { Accept: "application/nostr+json" },
    });
    assertEquals((await info.json()).pubkey, owner.pubkey);

    const socket = new WebSocket(`ws://127.0.0.1:${running.port}/`);
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error("could not connect"));
    });
    const eose = new Promise<void>((resolve) => {
      socket.onmessage = (message) => {
        const parsed = JSON.parse(String(message.data));
        if (parsed[0] === "EOSE") resolve();
      };
    });
    socket.send(JSON.stringify(["REQ", "all", { limit: 10 }]));
    await eose;

    const event = signEvent(owner, 1, "stored by the node test");
    const accepted = new Promise<unknown[]>((resolve) => {
      socket.onmessage = (message) => {
        const parsed = JSON.parse(String(message.data));
        if (parsed[0] === "OK") resolve(parsed);
      };
    });
    socket.send(JSON.stringify(["EVENT", event]));
    assertEquals((await accepted)[2], true);
    socket.close();

    const query = `SELECT ?c WHERE { ?e <${term("content")}> ?c }`;
    const sparql = await fetch(
      `${running.url}/sparql?query=${encodeURIComponent(query)}`,
    );
    assertEquals(sparql.status, 200);
    assertStringIncludes(await sparql.text(), "stored by the node test");
  } finally {
    await running.close();
    await running.close();
    await Deno.remove(dataDir, { recursive: true });
  }
});
