import { assertEquals } from "https://deno.land/std@0.111.0/testing/asserts.ts";
import { delay } from "https://deno.land/std@0.111.0/async/delay.ts";
import { flatten } from "./util.ts";

Deno.test("flaten", async () => {
  function innerGenerator(label: string, interval: number) {
    return timedGenerator(() => label, interval);
  }
  async function* timedGenerator(generate: () => any, interval: number) {
    for (let i = 0; i < 5; i++) {
      await delay(interval);
      yield generate();
    }
  }
  let innnerCount = 0;
  const outer = timedGenerator(
    () => innerGenerator("Inner: " + (++innnerCount), 20),
    30,
  );
  const results = [];
  for await (const value of { [Symbol.asyncIterator]: () => flatten(outer) }) {
    results.push(value);
    console.log(value);
  }
  assertEquals(25, results.length);
});
