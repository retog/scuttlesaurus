/**
 * Tests of the persisted replication coverage and of gap computation.
 * @module
 */
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { missingRanges, SYNC_STATE_FILE, SyncState } from "./sync_state.ts";

const R = "wss://relay.example/";

async function withDir(run: (dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  try {
    await run(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("missing ranges: everything when nothing is covered", () => {
  assertEquals(missingRanges(undefined, 100, 500, 10), [{
    from: 100,
    to: 500,
  }]);
});

Deno.test("missing ranges: the gap since the last run, with overlap", () => {
  assertEquals(
    missingRanges({ from: 100, to: 400 }, 100, 500, 10),
    [{ from: 390, to: 500 }],
  );
});

Deno.test("missing ranges: a grown horizon adds an older gap", () => {
  assertEquals(
    missingRanges({ from: 300, to: 400 }, 100, 500, 0),
    [{ from: 400, to: 500 }, { from: 100, to: 299 }],
  );
});

Deno.test("missing ranges: coverage outside the horizon counts for nothing", () => {
  assertEquals(missingRanges({ from: 1, to: 50 }, 100, 500, 10), [
    { from: 100, to: 500 },
  ]);
});

Deno.test("coverage survives a restart and is written on close", async () => {
  await withDir(async (dir) => {
    const state = await SyncState.open(dir, { flushMs: 60000 });
    state.extend(R, ["a"], 100, 200, false);
    await state.close();
    const again = await SyncState.open(dir, { flushMs: 60000 });
    assertEquals(again.get(R, "a"), { from: 100, to: 200 });
    assertEquals(again.get(R, "b"), undefined);
    await again.close();
    const names = [...Deno.readDirSync(dir)].map((e) => e.name);
    assertEquals(names, [SYNC_STATE_FILE], "no temporary file is left behind");
  });
});

Deno.test("writes are debounced", async () => {
  await withDir(async (dir) => {
    const state = await SyncState.open(dir, { flushMs: 30 });
    state.extend(R, ["a"], 1, 2, false);
    assertEquals(await exists(join(dir, SYNC_STATE_FILE)), false);
    for (
      let i = 0;
      i < 100 && !(await exists(join(dir, SYNC_STATE_FILE)));
      i++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assertEquals(await exists(join(dir, SYNC_STATE_FILE)), true);
    await state.close();
  });
});

Deno.test("ranges merge when they touch and partial records never leave a gap", async () => {
  await withDir(async (dir) => {
    const state = await SyncState.open(dir, { flushMs: 60000 });
    state.extend(R, ["a"], 100, 200, false);
    state.extend(R, ["a"], 50, 99, true);
    assertEquals(state.get(R, "a"), { from: 50, to: 200 });
    state.extend(R, ["a"], 300, 400, true); // disjoint and partial: ignored
    assertEquals(state.get(R, "a"), { from: 50, to: 200 });
    state.extend(R, ["a"], 300, 400, false); // complete: the newer range wins
    assertEquals(state.get(R, "a"), { from: 300, to: 400 });
    await state.close();
  });
});

Deno.test("a missing, corrupt or foreign state file means starting over", async () => {
  await withDir(async (dir) => {
    const file = join(dir, SYNC_STATE_FILE);
    assertEquals(
      (await SyncState.open(dir, { flushMs: 1 })).get(R, "a"),
      undefined,
    );
    for (
      const content of [
        "{ not json",
        "[]",
        JSON.stringify({ version: 99, relays: { [R]: { a: [1, 2] } } }),
        JSON.stringify({ version: 1, relays: "no" }),
      ]
    ) {
      await Deno.writeTextFile(file, content);
      const state = await SyncState.open(dir, { flushMs: 60000 });
      assertEquals(state.get(R, "a"), undefined, content);
      await state.close();
    }
  });
});

Deno.test("malformed entries are dropped, good ones kept", async () => {
  await withDir(async (dir) => {
    await Deno.writeTextFile(
      join(dir, SYNC_STATE_FILE),
      JSON.stringify({
        version: 1,
        relays: {
          [R]: {
            good: [1, 2],
            reversed: [5, 1],
            text: ["a", "b"],
            short: [1],
          },
        },
      }),
    );
    const state = await SyncState.open(dir, { flushMs: 60000 });
    assertEquals(state.get(R, "good"), { from: 1, to: 2 });
    for (const bad of ["reversed", "text", "short"]) {
      assertEquals(state.get(R, bad), undefined);
    }
    await state.close();
  });
});

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

Deno.test("coverage is kept per relay and pruned when it is too old", async () => {
  await withDir(async (dir) => {
    const state = await SyncState.open(dir, { flushMs: 60000 });
    state.extend(R, ["a"], 100, 200, false);
    state.extend("wss://other.example/", ["a"], 300, 400, false);
    assertEquals(state.get(R, "a"), { from: 100, to: 200 });
    assertEquals(state.get("wss://other.example/", "a"), {
      from: 300,
      to: 400,
    });
    state.prune(250);
    assertEquals(state.get(R, "a"), undefined);
    assertEquals(state.get("wss://other.example/", "a"), {
      from: 300,
      to: 400,
    });
    await state.close();
  });
});
