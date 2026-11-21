import { assertEquals } from "@std/assert";
import { busyWaitMs } from "./sparql.ts";

const answer = (status: number, retryAfter?: string) => ({
  status,
  headers: new Headers(
    retryAfter === undefined ? {} : {
      "Retry-After": retryAfter,
    },
  ),
});

Deno.test("a busy node is asked again after the time it names, within bounds", () => {
  assertEquals(busyWaitMs(answer(503, "15"), 0), 15_000);
  assertEquals(busyWaitMs(answer(429, "3"), 1), 3000);
  assertEquals(busyWaitMs(answer(503, "60"), 0), 20_000);
  assertEquals(busyWaitMs(answer(503, "0"), 0), 500);
  assertEquals(busyWaitMs(answer(503, "soon"), 0), 1000);
});

Deno.test("a final answer is not asked again", () => {
  // No Retry-After: the query itself took too long.
  assertEquals(busyWaitMs(answer(503), 0), undefined);
  assertEquals(busyWaitMs(answer(400, "5"), 0), undefined);
  assertEquals(busyWaitMs(answer(200), 0), undefined);
  // Three retries, then the error is shown.
  assertEquals(busyWaitMs(answer(503, "1"), 3), undefined);
});
