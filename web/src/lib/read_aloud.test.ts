/// <reference lib="deno.ns" />
/**
 * The paged source of the read-aloud player: it reads past rows that are
 * hidden, ends on a page of repeats, and retries a page that failed.
 *
 * @module
 */
import { assertEquals, assertRejects } from "@std/assert";

// `router.tsx`, loaded through `articles.ts`, touches `history` and `location`.
Reflect.set(globalThis, "history", {
  scrollRestoration: "manual",
  replaceState() {},
  pushState() {},
});
Reflect.set(globalThis, "location", new URL("http://localhost:7777/"));

const { pagedSource } = await import("./read_aloud.ts");

interface Row {
  key: string;
  at: number;
}

/** Rows "r9" (at 9) down to "r0" (at 0); `load(until)` is inclusive. */
const ROWS: Row[] = Array.from({ length: 10 }, (_, i) => ({
  key: `r${9 - i}`,
  at: 9 - i,
}));

function loader(pageSize: number, fail?: { times: number }) {
  return (until?: number) => {
    if (fail && fail.times > 0) {
      fail.times--;
      return Promise.reject(new Error("node unavailable"));
    }
    return Promise.resolve(
      ROWS.filter((r) => until === undefined || r.at <= until).slice(
        0,
        pageSize,
      ),
    );
  };
}

function source(
  load: (until?: number) => Promise<Row[]>,
  options: { skip?: (r: Row) => boolean; pageSize?: number } = {},
) {
  return pagedSource<Row>("test", {
    load,
    cursorOf: (r) => r.at,
    keyOf: (r) => r.key,
    pageSize: options.pageSize ?? 3,
    skip: options.skip,
    toItem: (r) =>
      Promise.resolve({ key: r.key, label: r.key, paragraphs: [] }),
  });
}

async function readAll(
  s: { next(): Promise<{ key: string } | null> },
): Promise<string[]> {
  const out: string[] = [];
  for (let item = await s.next(); item; item = await s.next()) {
    out.push(item.key);
  }
  return out;
}

Deno.test("every row is read once across inclusive pages", async () => {
  assertEquals(
    await readAll(source(loader(3))),
    ROWS.map((r) => r.key),
  );
});

Deno.test("a full page of hidden rows does not end the list", async () => {
  const hidden = new Set(["r8", "r7", "r6", "r5"]);
  assertEquals(
    await readAll(source(loader(3), { skip: (r) => hidden.has(r.key) })),
    ["r9", "r4", "r3", "r2", "r1", "r0"],
  );
});

Deno.test("a page of repeats ends the list", async () => {
  // Every row at the same position: the cursor cannot move past them.
  const same = Array.from({ length: 5 }, (_, i) => ({ key: `s${i}`, at: 1 }));
  const load = () => Promise.resolve(same.slice(0, 3));
  assertEquals(await readAll(source(load)), ["s0", "s1", "s2"]);
});

Deno.test("a failed page is loaded again on the next call", async () => {
  const fail = { times: 0 };
  const s = source(loader(3, fail));
  assertEquals((await s.next())?.key, "r9");
  assertEquals((await s.next())?.key, "r8");
  assertEquals((await s.next())?.key, "r7");
  fail.times = 1;
  await assertRejects(() => s.next(), Error, "node unavailable");
  assertEquals((await s.next())?.key, "r6");
  assertEquals(await readAll(s), ["r5", "r4", "r3", "r2", "r1", "r0"]);
});
