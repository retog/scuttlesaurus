import { assertEquals } from "https://deno.land/std@0.129.0/testing/asserts.ts";
import DenoScuttlebuttHost from "./DenoScuttlebuttHost.ts";
import { getFreePort } from "https://deno.land/x/free_port@v1.2.0/mod.ts";
import { delay } from "./util.ts";

Deno.test("Server -> Client Message Flow", async () => {
  const controller = new AbortController();
  const serverDir = await Deno.makeTempDir({
    prefix: "scuttlesuarus-test-server",
  });
  const port: number = await getFreePort(9090);
  const server = new DenoScuttlebuttHost({
    baseDir: serverDir,
    transport: {
      net: {
        port,
      },
    },
  });
  const serverP = server.start(controller.signal);
  const serverAddress =
    `net:127.0.0.1:${port}~shs:${server.identity.base64Key}`;
  const clientDir = await Deno.makeTempDir({
    prefix: "scuttlesuarus-test-client",
  });
  const client = new DenoScuttlebuttHost({
    baseDir: clientDir,
    peers: [serverAddress],
    follow: [server.identity.toString()],
    transport: {
      net: {
        port: await getFreePort(9091), //TODO support client only interface
      },
    },
  });
  const clientP = client.start(controller.signal);
  server.publish({
    type: "test",
    value: 42,
  });
  await delay(500);
  const feed = client.feedsAgent?.getFeed(server.identity);
  const firstMsg = (await feed?.[Symbol.asyncIterator]().next())!.value;
  if (firstMsg.value.content.value !== 42) {
    throw Error("other peer got wrong message");
  }
  assertEquals(firstMsg.value.content.value, 42);
  controller.abort();
  await delay(600); //allows rpc-timeout checker to realize connection is closed
  await serverP;
  await clientP;
});
