import { assertEquals } from "@std/assert";
import { makeFixture, newSigner, signEvent } from "./test_helpers.ts";

Deno.test("a WebSocket on / is upgraded to the relay and answers REQ with EOSE", async () => {
  const owner = newSigner();
  const fixture = await makeFixture({ env: { OWNER: owner.pubkey } });
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    fixture.handler,
  );
  const socket = new WebSocket(`ws://127.0.0.1:${server.addr.port}/`);
  try {
    const messages: unknown[] = [];
    const answered = new Promise<void>((resolve, reject) => {
      socket.onerror = () => reject(new Error("socket error"));
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data));
        messages.push(message);
        if (message[0] === "EOSE") resolve();
      };
    });
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error("could not connect"));
    });

    socket.send(JSON.stringify(["REQ", "sub", { kinds: [1], limit: 5 }]));
    await answered;
    assertEquals(messages, [["EOSE", "sub"]]);
  } finally {
    socket.close();
    await server.shutdown();
    await fixture.close();
  }
});

Deno.test("a published event is accepted by the relay over the WebSocket", async () => {
  const owner = newSigner();
  const fixture = await makeFixture({
    env: { OWNER: owner.pubkey },
    distances: { [owner.pubkey]: 0 },
  });
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    fixture.handler,
  );
  const socket = new WebSocket(`ws://127.0.0.1:${server.addr.port}/`);
  try {
    const event = signEvent(owner, 1, "over the socket");
    const accepted = new Promise<unknown[]>((resolve, reject) => {
      socket.onerror = () => reject(new Error("socket error"));
      socket.onmessage = (message) => {
        const parsed = JSON.parse(String(message.data));
        if (parsed[0] === "OK") resolve(parsed);
      };
    });
    await new Promise<void>((resolve) => {
      socket.onopen = () => resolve();
    });
    socket.send(JSON.stringify(["EVENT", event]));
    const ok = await accepted;
    assertEquals(ok, ["OK", event.id, true, ""]);
    assertEquals(fixture.events.has(event.id), true);
  } finally {
    socket.close();
    await server.shutdown();
    await fixture.close();
  }
});
