/**
 * Tests for the configuration module. Each test uses its own temporary
 * DATA_DIR and passes the environment explicitly, so nothing depends on the
 * process environment.
 * @module
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { generateSecretKey, getPublicKey } from "@nostr/tools/pure";
import * as nip19 from "@nostr/tools/nip19";
import { normalizeURL } from "@nostr/tools/utils";
import { loadConfig } from "./config.ts";
import type { Config } from "./types.ts";

const HEX = "a".repeat(63) + "1";
const DEFAULT_DESCRIPTION =
  "A personal Nostr relay that replicates its owner's social neighbourhood.";

/** Runs `run` with a fresh temporary data directory, removed afterwards. */
async function withDataDir(
  run: (dir: string) => Promise<unknown>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await run(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Silences `console.error` while `run` executes, returning the call count. */
async function quietly(run: () => Promise<void>): Promise<number> {
  const original = console.error;
  let calls = 0;
  console.error = () => {
    calls++;
  };
  try {
    await run();
  } finally {
    console.error = original;
  }
  return calls;
}

Deno.test("defaults with an empty environment", () =>
  withDataDir(async (dir) => {
    const manager = await loadConfig({ DATA_DIR: dir });
    const config = manager.config;

    assertEquals(config.owner, undefined);
    assertEquals(config.publicUrl, undefined);
    assertEquals(config.hostname, "127.0.0.1");
    assertEquals(config.port, 7777);
    assertEquals(config.dataDir, dir);
    assertEquals(config.name, "Scuttlesaurus");
    assertEquals(config.description, DEFAULT_DESCRIPTION);
    assertEquals(config.replication, {
      enabled: true,
      hops: 2,
      maxAuthors: 1500,
      horizonDays: [0, 90, 14],
      bootstrapRelays: [
        "wss://relay.damus.io/",
        "wss://nos.lol/",
        "wss://relay.primal.net/",
        "wss://purplepag.es/",
      ],
      maxRelays: 12,
      forward: "all",
      allowPrivateRelays: false,
    });
    assertEquals(config.store, { kind: "embedded" });
    assertEquals(config.blossom, {
      enabled: true,
      maxBlobSize: 50 * 1024 * 1024,
    });
    assertEquals(config.publicSparql, true);
    assertEquals(config.nostrConnect, true);
    assertEquals(config.maxLimit, 500);
    assertEquals(manager.locked.size, 0);
    assert((await Deno.stat(dir)).isDirectory);
  }));

Deno.test("creates a missing data directory", () =>
  withDataDir(async (parent) => {
    const dir = join(parent, "nested", "data");
    await loadConfig({ DATA_DIR: dir });
    assert((await Deno.stat(dir)).isDirectory);
  }));

Deno.test("each environment variable sets its setting", () =>
  withDataDir(async (dir) => {
    const manager = await loadConfig({
      DATA_DIR: dir,
      OWNER: HEX.toUpperCase(),
      PORT: "8080",
      HOSTNAME: "0.0.0.0",
      PUBLIC_URL: "https://saurus.example.org/",
      RELAY_NAME: "Mine",
      RELAY_DESCRIPTION: "My relay",
      HOPS: "3",
      MAX_AUTHORS: "200",
      HORIZON_DAYS: "0, 30,7",
      BOOTSTRAP_RELAYS: "wss://a.example.com, ws://b.example.com/",
      MAX_RELAYS: "4",
      FORWARD: "owner",
      REPLICATION: "off",
      ALLOW_PRIVATE_RELAYS: "on",
      SPARQL_PUBLIC: "0",
      NOSTR_CONNECT: "off",
      BLOSSOM: "false",
      BLOSSOM_MAX_SIZE_MB: "10",
      MAX_LIMIT: "100",
    });
    const c = manager.config;

    assertEquals(c.owner, HEX);
    assertEquals(c.port, 8080);
    assertEquals(c.hostname, "0.0.0.0");
    assertEquals(c.publicUrl, "https://saurus.example.org");
    assertEquals(c.name, "Mine");
    assertEquals(c.description, "My relay");
    assertEquals(c.replication, {
      enabled: false,
      hops: 3,
      maxAuthors: 200,
      horizonDays: [0, 30, 7],
      bootstrapRelays: [
        normalizeURL("wss://a.example.com"),
        normalizeURL("ws://b.example.com/"),
      ],
      maxRelays: 4,
      forward: "owner",
      allowPrivateRelays: true,
    });
    assertEquals(c.publicSparql, false);
    assertEquals(c.nostrConnect, false);
    assertEquals(c.blossom, { enabled: false, maxBlobSize: 10 * 1024 * 1024 });
    assertEquals(c.maxLimit, 100);
  }));

Deno.test("toggles accept on, true and 1 as enabled", () =>
  withDataDir(async (dir) => {
    for (const word of ["on", "true", "1", "ON"]) {
      const manager = await loadConfig({
        DATA_DIR: dir,
        REPLICATION: word,
        BLOSSOM: word,
        SPARQL_PUBLIC: word,
        NOSTR_CONNECT: word,
      });
      assertEquals(manager.config.replication.enabled, true);
      assertEquals(manager.config.blossom.enabled, true);
      assertEquals(manager.config.publicSparql, true);
      assertEquals(manager.config.nostrConnect, true);
    }
  }));

Deno.test("owner accepts an npub or a hex key", () =>
  withDataDir(async (dir) => {
    const secret = generateSecretKey();
    const hex = getPublicKey(secret);
    const npub = nip19.npubEncode(hex);

    const fromNpub = await loadConfig({ DATA_DIR: dir, OWNER: npub });
    assertEquals(fromNpub.config.owner, hex);

    const fromHex = await loadConfig({
      DATA_DIR: dir,
      OWNER: hex.toUpperCase(),
    });
    assertEquals(fromHex.config.owner, hex);
  }));

Deno.test("empty environment variables are treated as unset", () =>
  withDataDir(async (dir) => {
    const manager = await loadConfig({ DATA_DIR: dir, OWNER: "", PORT: " " });
    assertEquals(manager.config.owner, undefined);
    assertEquals(manager.config.port, 7777);
    assertEquals(manager.locked.size, 0);
  }));

Deno.test("invalid environment values throw, naming the variable", async () => {
  const invalid: [string, string][] = [
    ["OWNER", "npub1xyz"],
    ["OWNER", "not a key"],
    ["PORT", "abc"],
    ["PORT", "70000"],
    ["PORT", "-1"],
    ["HOPS", "9"],
    ["MAX_AUTHORS", "0"],
    ["MAX_RELAYS", "101"],
    ["HORIZON_DAYS", "0,-1"],
    ["HORIZON_DAYS", "x"],
    ["BOOTSTRAP_RELAYS", "https://relay.example.com"],
    ["BOOTSTRAP_RELAYS", "wss://"],
    ["FORWARD", "some"],
    ["PUBLIC_URL", "ftp://example.org"],
    ["PUBLIC_URL", "not a url"],
    ["REPLICATION", "maybe"],
    ["ALLOW_PRIVATE_RELAYS", "maybe"],
    ["BLOSSOM", "maybe"],
    ["SPARQL_PUBLIC", "maybe"],
    ["NOSTR_CONNECT", "maybe"],
    ["BLOSSOM_MAX_SIZE_MB", "1.5"],
    ["MAX_LIMIT", "0"],
    ["SPARQL_ENDPOINT_QUERY", "ftp://example.org/query"],
    ["SPARQL_ENDPOINT_CREDENTIALS", "nocolon"],
    ["QLEVER_DIR_URL", "ftp://qlever:7001/"],
    ["QLEVER_DIR_URL", "qlever"],
  ];
  for (const [variable, value] of invalid) {
    await withDataDir((dir) =>
      assertRejects(
        () => loadConfig({ DATA_DIR: dir, [variable]: value }),
        Error,
        `${variable}=`,
      )
    );
  }
});

Deno.test("the invalid value appears in the error", () =>
  withDataDir((dir) =>
    assertRejects(
      () => loadConfig({ DATA_DIR: dir, HOPS: "9" }),
      Error,
      '"9"',
    )
  ));

Deno.test("SPARQL update and credentials without a query endpoint throw", () =>
  withDataDir((dir) =>
    assertRejects(
      () => loadConfig({ DATA_DIR: dir, SPARQL_ENDPOINT_UPDATE: "http://u" }),
      Error,
      "SPARQL_ENDPOINT_QUERY",
    )
  ));

Deno.test("config.json is overlaid on defaults and overridden by the environment", () =>
  withDataDir(async (dir) => {
    const owner = getPublicKey(generateSecretKey());
    await Deno.writeTextFile(
      join(dir, "config.json"),
      JSON.stringify({
        owner: nip19.npubEncode(owner),
        name: "From file",
        publicUrl: "https://file.example.org/",
        replication: { hops: 3, forward: "owner" },
      }),
    );

    const manager = await loadConfig({
      DATA_DIR: dir,
      RELAY_NAME: "From env",
      HOPS: "1",
    });
    const c = manager.config;

    assertEquals(c.owner, owner);
    assertEquals(c.name, "From env");
    assertEquals(c.publicUrl, "https://file.example.org");
    assertEquals(c.replication.hops, 1);
    assertEquals(c.replication.forward, "owner");
    assertEquals(c.replication.maxRelays, 12);
    assertEquals(c.port, 7777);
    assertEquals([...manager.locked].sort(), ["name", "replication.hops"]);
  }));

Deno.test("an invalid config.json throws, naming the file", async () => {
  await withDataDir(async (dir) => {
    const path = join(dir, "config.json");
    await Deno.writeTextFile(path, "{ not json");
    await assertRejects(() => loadConfig({ DATA_DIR: dir }), Error, path);
  });
  await withDataDir(async (dir) => {
    const path = join(dir, "config.json");
    await Deno.writeTextFile(
      path,
      JSON.stringify({ replication: { hops: 9 } }),
    );
    await assertRejects(() => loadConfig({ DATA_DIR: dir }), Error, path);
  });
});

Deno.test("locked lists exactly the changeable settings given by the environment", () =>
  withDataDir(async (dir) => {
    const manager = await loadConfig({
      DATA_DIR: dir,
      OWNER: HEX,
      RELAY_NAME: "Name",
      RELAY_DESCRIPTION: "Description",
      PUBLIC_URL: "https://example.org",
      HOPS: "1",
      MAX_AUTHORS: "10",
      HORIZON_DAYS: "0",
      BOOTSTRAP_RELAYS: "wss://relay.example.com",
      MAX_RELAYS: "2",
      FORWARD: "none",
      REPLICATION: "on",
      ALLOW_PRIVATE_RELAYS: "off",
      // Not changeable through update, so not locked.
      PORT: "9000",
      BLOSSOM: "off",
      MAX_LIMIT: "50",
    });
    assertEquals(
      [...manager.locked].sort(),
      [
        "name",
        "description",
        "owner",
        "publicUrl",
        "replication.enabled",
        "replication.hops",
        "replication.maxAuthors",
        "replication.horizonDays",
        "replication.bootstrapRelays",
        "replication.maxRelays",
        "replication.forward",
        "replication.allowPrivateRelays",
      ].sort(),
    );
  }));

Deno.test("update persists changes, mutates the same object and notifies", () =>
  withDataDir(async (dir) => {
    const manager = await loadConfig({ DATA_DIR: dir });
    const before = manager.config;
    const seen: Config[] = [];
    manager.onChange((config) => seen.push(config));

    const owner = getPublicKey(generateSecretKey());
    await manager.update({
      owner: nip19.npubEncode(owner),
      name: "New name",
      publicUrl: "https://x.example.org/",
      replication: { hops: 3, horizonDays: [0, 30] },
    });

    assert(manager.config === before);
    assertEquals(before.owner, owner);
    assertEquals(before.name, "New name");
    assertEquals(before.publicUrl, "https://x.example.org");
    assertEquals(before.replication.hops, 3);
    assertEquals(before.replication.horizonDays, [0, 30]);
    assertEquals(seen.length, 1);
    assert(seen[0] === before);

    const text = await Deno.readTextFile(join(dir, "config.json"));
    assertEquals(JSON.parse(text), {
      owner,
      name: "New name",
      publicUrl: "https://x.example.org",
      replication: { hops: 3, horizonDays: [0, 30] },
    });
    assert(text.includes('\n  "name"'), "config.json is pretty-printed");
    const leftovers = [...Deno.readDirSync(dir)].filter((e) =>
      e.name.endsWith(".tmp")
    );
    assertEquals(leftovers, []);
  }));

Deno.test("a throwing listener does not stop the others", () =>
  withDataDir(async (dir) => {
    const manager = await loadConfig({ DATA_DIR: dir });
    let notified = 0;
    manager.onChange(() => {
      throw new Error("boom");
    });
    manager.onChange(() => {
      notified++;
    });

    const logged = await quietly(() =>
      manager.update({ name: "Still applied" })
    );

    assertEquals(notified, 1);
    assertEquals(logged, 1);
    assertEquals(manager.config.name, "Still applied");
  }));

Deno.test("the unsubscribe function removes a listener", () =>
  withDataDir(async (dir) => {
    const manager = await loadConfig({ DATA_DIR: dir });
    let calls = 0;
    const unsubscribe = manager.onChange(() => {
      calls++;
    });
    unsubscribe();
    await manager.update({ name: "Quiet" });
    assertEquals(calls, 0);
  }));

Deno.test("update of a locked setting throws and changes nothing", () =>
  withDataDir(async (dir) => {
    const manager = await loadConfig({ DATA_DIR: dir, RELAY_NAME: "Fixed" });
    await assertRejects(
      () => manager.update({ name: "Other", replication: { hops: 3 } }),
      Error,
      "RELAY_NAME",
    );
    assertEquals(manager.config.name, "Fixed");
    assertEquals(manager.config.replication.hops, 2);
    let exists = true;
    try {
      await Deno.stat(join(dir, "config.json"));
    } catch {
      exists = false;
    }
    assertEquals(exists, false);
  }));

Deno.test("update accepts a locked setting at its current value", () =>
  withDataDir(async (dir) => {
    const manager = await loadConfig({ DATA_DIR: dir, RELAY_NAME: "Fixed" });
    await manager.update({ name: "Fixed", description: "Changed" });
    assertEquals(manager.config.description, "Changed");
  }));

Deno.test("an invalid update applies nothing", () =>
  withDataDir(async (dir) => {
    const manager = await loadConfig({ DATA_DIR: dir });
    await assertRejects(
      () => manager.update({ name: "Changed", replication: { hops: 9 } }),
      Error,
      "hops",
    );
    await assertRejects(
      () => manager.update({ owner: "npub1nope" }),
      Error,
      "owner",
    );
    assertEquals(manager.config.name, "Scuttlesaurus");
    assertEquals(manager.config.replication.hops, 2);
    assertEquals(manager.config.owner, undefined);
  }));

Deno.test("a reload after update yields the same configuration", () =>
  withDataDir(async (dir) => {
    const manager = await loadConfig({ DATA_DIR: dir, MAX_LIMIT: "250" });
    await manager.update({
      name: "A",
      publicUrl: "https://a.example.org",
      owner: getPublicKey(generateSecretKey()),
      replication: {
        maxRelays: 5,
        bootstrapRelays: ["wss://relay.example.com"],
      },
    });
    await manager.update({ publicUrl: "" });

    const reloaded = await loadConfig({ DATA_DIR: dir, MAX_LIMIT: "250" });
    assertEquals(reloaded.config, manager.config);
    assertEquals(reloaded.config.publicUrl, undefined);
    assertEquals(reloaded.config.replication.maxRelays, 5);
  }));

Deno.test("the sparql store is selected by SPARQL_ENDPOINT_QUERY", () =>
  withDataDir(async (dir) => {
    const plain = await loadConfig({
      DATA_DIR: dir,
      SPARQL_ENDPOINT_QUERY: "http://localhost:7878/query",
    });
    assertEquals(plain.config.store, {
      kind: "sparql",
      queryUrl: "http://localhost:7878/query",
      updateUrl: "http://localhost:7878/query",
    });

    const full = await loadConfig({
      DATA_DIR: dir,
      SPARQL_ENDPOINT_QUERY: "https://graph.example.org/query",
      SPARQL_ENDPOINT_UPDATE: "https://graph.example.org/update",
      SPARQL_ENDPOINT_CREDENTIALS: "user:secret",
    });
    assertEquals(full.config.store, {
      kind: "sparql",
      queryUrl: "https://graph.example.org/query",
      updateUrl: "https://graph.example.org/update",
      credentials: "user:secret",
    });
  }));

Deno.test("bootstrap relay defaults are not locked and keep their order", () =>
  withDataDir(async (dir) => {
    const manager = await loadConfig({ DATA_DIR: dir });
    assertEquals(
      manager.config.replication.bootstrapRelays[0],
      "wss://relay.damus.io/",
    );
    assertEquals(manager.locked.has("replication.bootstrapRelays"), false);
  }));

Deno.test("qlever-dir store: selected by QLEVER_DIR_URL, with defaults", () =>
  withDataDir(async (dir) => {
    const plain = await loadConfig({
      DATA_DIR: dir,
      QLEVER_DIR_URL: "http://qlever:7001/",
    });
    assertEquals(plain.config.store, {
      kind: "qlever-dir",
      queryUrl: "http://qlever:7001",
      graphDir: join(dir, "graph"),
      baseUri: "https://example.org/data/",
    });

    const full = await loadConfig({
      DATA_DIR: dir,
      QLEVER_DIR_URL: "http://qlever:7001",
      QLEVER_DIR_GRAPH_DIR: "/srv/graph",
      QLEVER_DIR_BASE_URI: "https://scuttlesaurus.test/graph/",
    });
    assertEquals(full.config.store, {
      kind: "qlever-dir",
      queryUrl: "http://qlever:7001",
      graphDir: "/srv/graph",
      baseUri: "https://scuttlesaurus.test/graph/",
    });
  }));

Deno.test("qlever-dir store: invalid and conflicting settings throw", async () => {
  const cases: [Record<string, string>, string][] = [
    [{
      QLEVER_DIR_URL: "http://q:1",
      QLEVER_DIR_BASE_URI: "https://x.org/data",
    }, "QLEVER_DIR_BASE_URI="],
    [
      { QLEVER_DIR_URL: "http://q:1", QLEVER_DIR_BASE_URI: "relative/" },
      "QLEVER_DIR_BASE_URI=",
    ],
    [
      { QLEVER_DIR_URL: "http://q:1", QLEVER_DIR_BASE_URI: "ftp://x.org/" },
      "QLEVER_DIR_BASE_URI=",
    ],
    [{
      QLEVER_DIR_URL: "http://q:1",
      SPARQL_ENDPOINT_QUERY: "http://s:2/query",
    }, "different stores"],
    [{ QLEVER_DIR_GRAPH_DIR: "/srv/graph" }, "without QLEVER_DIR_URL"],
    [{ QLEVER_DIR_BASE_URI: "https://x.org/" }, "without QLEVER_DIR_URL"],
  ];
  for (const [env, message] of cases) {
    await withDataDir((dir) =>
      assertRejects(() => loadConfig({ DATA_DIR: dir, ...env }), Error, message)
    );
  }
});
