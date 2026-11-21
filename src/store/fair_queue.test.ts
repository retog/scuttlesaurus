import { assertEquals } from "@std/assert";
import { FairQueue } from "./fair_queue.ts";

Deno.test("FairQueue serves keys in turn and keeps each key's own order", () => {
  const q = new FairQueue<string>();
  for (
    const [k, v] of [["a", "a1"], ["a", "a2"], ["a", "a3"], ["b", "b1"], [
      "c",
      "c1",
    ], ["b", "b2"]]
  ) q.push(k, v);
  assertEquals(q.length, 6);
  assertEquals(q.drain(), ["a1", "b1", "c1", "a2", "b2", "a3"]);
  assertEquals(q.length, 0);
  assertEquals(q.shift(), undefined);
});

Deno.test("FairQueue: a client that was just served goes behind one that was not", () => {
  const q = new FairQueue<string>();
  q.push("a", "a1");
  q.push("a", "a2");
  assertEquals(q.shift(), "a1");
  q.push("b", "b1");
  q.push("b", "b2");
  // a was served, b was not: b goes first, then they alternate.
  assertEquals(q.drain(), ["b1", "a2", "b2"]);
});

Deno.test("FairQueue.remove takes out a queued item only", () => {
  const q = new FairQueue<string>();
  q.push("a", "a1");
  q.push("b", "b1");
  assertEquals(q.remove("a1"), true);
  assertEquals(q.remove("a1"), false);
  assertEquals(q.length, 1);
  assertEquals(q.shift(), "b1");
});
