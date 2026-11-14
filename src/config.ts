/**
 * Configuration loading and runtime updates. Contract: `docs/ARCHITECTURE.md`.
 *
 * The effective configuration is built from three layers, each overriding the
 * one before it: built-in defaults, `<dataDir>/config.json`, and environment
 * variables. Every value is checked when it enters a layer, so the assembled
 * configuration never needs to re-validate.
 * @module
 */
import { join } from "@std/path";
import * as nip19 from "@nostr/tools/nip19";
import { normalizeURL } from "@nostr/tools/utils";
import type {
  Config,
  ConfigManager,
  ConfigPatch,
  StoreConfig,
} from "./types.ts";

/** A nested record of setting values; leaves are addressed by dotted paths. */
type Raw = Record<string, unknown>;

/** Validates and normalizes one setting value, or throws with the reason. */
type Check = (value: unknown) => unknown;

/** Builds the error thrown when a setting value is rejected. */
type Fail = (key: string, value: unknown, reason: string) => Error;

type Listener = (config: Config) => void;

const MEGABYTE = 1024 * 1024;

/** qlever-dir's own default `BASE_URI`, which matches a graph directory mounted as `/data`. */
const DEFAULT_QLEVER_BASE_URI = "https://example.org/data/";

const DEFAULT_DESCRIPTION =
  "A personal Nostr relay that replicates its owner's social neighbourhood.";

/** Built-in defaults. `owner` and `publicUrl` have none and are left unset. */
const DEFAULTS: Raw = {
  hostname: "127.0.0.1",
  port: 7777,
  name: "Scuttlesaurus",
  description: DEFAULT_DESCRIPTION,
  replication: {
    enabled: true,
    hops: 2,
    maxAuthors: 1500,
    horizonDays: [0, 90, 14],
    // In the normalized form relay IRIs have everywhere (docs/DATA-MODEL.md).
    bootstrapRelays: [
      "wss://relay.damus.io/",
      "wss://nos.lol/",
      "wss://relay.primal.net/",
      "wss://purplepag.es/",
    ],
    maxRelays: 12,
    forward: "all",
    allowPrivateRelays: false,
  },
  blossom: { enabled: true, maxBlobSize: 50 * MEGABYTE },
  publicSparql: true,
  nostrConnect: true,
  maxLimit: 500,
};

/** The settings that `config.json` holds and `update` may change. */
const CHANGEABLE = [
  "owner",
  "name",
  "description",
  "publicUrl",
  "replication.enabled",
  "replication.hops",
  "replication.maxAuthors",
  "replication.horizonDays",
  "replication.bootstrapRelays",
  "replication.maxRelays",
  "replication.forward",
  "replication.allowPrivateRelays",
] as const;

/** Converts a raw environment string into a value for a setting. */
type Parse = (raw: string) => unknown;

/** One environment variable and the setting it provides. */
interface EnvSetting {
  readonly variable: string;
  readonly key: string;
  readonly parse: Parse;
}

/** The environment variables, in the order of the table in the architecture doc. */
const ENV_SETTINGS: readonly EnvSetting[] = [
  { variable: "OWNER", key: "owner", parse: parseText },
  { variable: "PORT", key: "port", parse: parseInteger },
  { variable: "HOSTNAME", key: "hostname", parse: parseText },
  { variable: "PUBLIC_URL", key: "publicUrl", parse: parseText },
  { variable: "RELAY_NAME", key: "name", parse: parseText },
  { variable: "RELAY_DESCRIPTION", key: "description", parse: parseText },
  { variable: "HOPS", key: "replication.hops", parse: parseInteger },
  {
    variable: "MAX_AUTHORS",
    key: "replication.maxAuthors",
    parse: parseInteger,
  },
  {
    variable: "HORIZON_DAYS",
    key: "replication.horizonDays",
    parse: parseList(parseInteger),
  },
  {
    variable: "BOOTSTRAP_RELAYS",
    key: "replication.bootstrapRelays",
    parse: parseList(parseText),
  },
  { variable: "MAX_RELAYS", key: "replication.maxRelays", parse: parseInteger },
  { variable: "FORWARD", key: "replication.forward", parse: parseText },
  { variable: "REPLICATION", key: "replication.enabled", parse: parseToggle },
  {
    variable: "ALLOW_PRIVATE_RELAYS",
    key: "replication.allowPrivateRelays",
    parse: parseToggle,
  },
  {
    variable: "SPARQL_ENDPOINT_QUERY",
    key: "store.queryUrl",
    parse: parseText,
  },
  {
    variable: "SPARQL_ENDPOINT_UPDATE",
    key: "store.updateUrl",
    parse: parseText,
  },
  {
    variable: "SPARQL_ENDPOINT_CREDENTIALS",
    key: "store.credentials",
    parse: parseText,
  },
  { variable: "QLEVER_DIR_URL", key: "store.qleverUrl", parse: parseText },
  {
    variable: "QLEVER_DIR_GRAPH_DIR",
    key: "store.qleverGraphDir",
    parse: parseText,
  },
  {
    variable: "QLEVER_DIR_BASE_URI",
    key: "store.qleverBaseUri",
    parse: parseText,
  },
  { variable: "SPARQL_PUBLIC", key: "publicSparql", parse: parseToggle },
  { variable: "NOSTR_CONNECT", key: "nostrConnect", parse: parseToggle },
  { variable: "BLOSSOM", key: "blossom.enabled", parse: parseToggle },
  {
    variable: "BLOSSOM_MAX_SIZE_MB",
    key: "blossom.maxBlobSize",
    parse: parseMegabytes,
  },
  { variable: "MAX_LIMIT", key: "maxLimit", parse: parseInteger },
];

/** The validator for each setting, by dotted path. */
const CHECKS: Record<string, Check> = {
  owner: checkOwner,
  name: checkText,
  description: checkText,
  publicUrl: checkPublicUrl,
  hostname: checkText,
  port: checkRange(0, 65535),
  "replication.enabled": checkBoolean,
  "replication.hops": checkRange(0, 4),
  "replication.maxAuthors": checkRange(1, 100000),
  "replication.horizonDays": checkHorizonDays,
  "replication.bootstrapRelays": checkRelayUrls,
  "replication.maxRelays": checkRange(1, 100),
  "replication.forward": checkOneOf(["none", "owner", "all"]),
  "replication.allowPrivateRelays": checkBoolean,
  "store.queryUrl": checkHttpUrl,
  "store.updateUrl": checkHttpUrl,
  "store.credentials": checkCredentials,
  "store.qleverUrl": checkHttpUrl,
  "store.qleverGraphDir": checkNonEmptyText,
  "store.qleverBaseUri": checkBaseUri,
  publicSparql: checkBoolean,
  nostrConnect: checkBoolean,
  "blossom.enabled": checkBoolean,
  "blossom.maxBlobSize": checkRange(1, Number.MAX_SAFE_INTEGER),
  maxLimit: checkRange(1, Number.MAX_SAFE_INTEGER),
};

/**
 * Build the effective configuration from defaults, `<dataDir>/config.json`
 * and the given environment (defaults to the process environment).
 *
 * Creates `dataDir` if it is missing. Throws if an environment variable or
 * `config.json` holds an invalid value; the error names the variable or file.
 */
export async function loadConfig(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): Promise<ConfigManager> {
  const dataDir = env.DATA_DIR?.trim() || "./data";
  await Deno.mkdir(dataDir, { recursive: true });
  const path = join(dataDir, "config.json");

  let file = await readSettingsFile(path);
  const { layer, lockedBy } = readEnvironment(env);
  const config = assemble(dataDir, file, layer);
  const listeners = new Set<Listener>();
  let queue: Promise<void> = Promise.resolve();

  const apply = async (patch: ConfigPatch): Promise<void> => {
    const changes = checkSettings(
      patch,
      (key, value, reason) =>
        new Error(`Invalid setting ${key} ${JSON.stringify(value)}: ${reason}`),
    );

    const refused = [...changes]
      .filter(([key, value]) =>
        lockedBy.has(key) &&
        JSON.stringify(value) !== JSON.stringify(getIn(config, key))
      )
      .map(([key]) => `${key} (${lockedBy.get(key)})`);
    if (refused.length > 0) {
      throw new Error(
        `Cannot change ${refused.join(", ")}: set by environment variable`,
      );
    }

    const nextFile = structuredClone(file);
    for (const [key, value] of changes) setIn(nextFile, key, value);
    const next = assemble(dataDir, nextFile, layer);

    await writeFileAtomic(path, serializeSettings(nextFile));

    file = nextFile;
    config.owner = next.owner;
    config.name = next.name;
    config.description = next.description;
    config.publicUrl = next.publicUrl;
    Object.assign(config.replication, next.replication);

    for (const listener of [...listeners]) {
      try {
        listener(config);
      } catch (error) {
        console.error("A configuration listener failed:", error);
      }
    }
  };

  return {
    config,
    locked: new Set(lockedBy.keys()),
    update(patch: ConfigPatch): Promise<void> {
      // Serialize updates so each one validates against the last one applied.
      const run = queue.then(() => apply(patch));
      queue = run.catch(() => {});
      return run;
    },
    onChange(listener: Listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

/** Reads `config.json`; a missing file is an empty layer. */
async function readSettingsFile(path: string): Promise<Raw> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return {};
    throw new Error(`Cannot read ${path}: ${messageOf(error)}`, {
      cause: error,
    });
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid ${path}: not valid JSON (${messageOf(error)})`);
  }
  if (!isRecord(json)) {
    throw new Error(`Invalid ${path}: expected a JSON object`);
  }

  const checked = checkSettings(
    json,
    (key, value, reason) =>
      new Error(
        `Invalid ${path}: ${key} ${JSON.stringify(value)}: ${reason}`,
      ),
  );
  const layer: Raw = {};
  for (const [key, value] of checked) setIn(layer, key, value);
  return layer;
}

/**
 * Reads the environment into a layer. Variables that are unset or empty are
 * ignored. Also returns which changeable settings it provides, and by which
 * variable, so that those settings are locked.
 */
function readEnvironment(
  env: Record<string, string | undefined>,
): { layer: Raw; lockedBy: Map<string, string> } {
  const layer: Raw = {};
  const lockedBy = new Map<string, string>();

  for (const setting of ENV_SETTINGS) {
    const raw = env[setting.variable]?.trim();
    if (raw === undefined || raw === "") continue;

    let value: unknown;
    try {
      value = CHECKS[setting.key](setting.parse(raw));
    } catch (error) {
      throw new Error(
        `Invalid ${setting.variable}=${JSON.stringify(raw)}: ${
          messageOf(error)
        }`,
      );
    }
    if (value === undefined) continue;

    setIn(layer, setting.key, value);
    if ((CHANGEABLE as readonly string[]).includes(setting.key)) {
      lockedBy.set(setting.key, setting.variable);
    }
  }

  const queryUrl = getIn(layer, "store.queryUrl");
  if (getIn(layer, "store.qleverUrl") !== undefined) {
    if (queryUrl !== undefined) {
      throw new Error(
        "QLEVER_DIR_URL and SPARQL_ENDPOINT_QUERY select different stores; set only one",
      );
    }
  } else {
    for (const variable of ["QLEVER_DIR_GRAPH_DIR", "QLEVER_DIR_BASE_URI"]) {
      if (env[variable]?.trim()) {
        throw new Error(`${variable} is set without QLEVER_DIR_URL`);
      }
    }
  }
  if (queryUrl === undefined) {
    for (
      const variable of [
        "SPARQL_ENDPOINT_UPDATE",
        "SPARQL_ENDPOINT_CREDENTIALS",
      ]
    ) {
      const raw = env[variable]?.trim();
      if (raw) {
        throw new Error(`${variable} is set without SPARQL_ENDPOINT_QUERY`);
      }
    }
  }
  return { layer, lockedBy };
}

/**
 * Checks each changeable setting present in `source`. Returns the checked
 * values by dotted path; a value may be `undefined` to mean "cleared".
 */
function checkSettings(source: Raw, fail: Fail): Map<string, unknown> {
  if (source.replication !== undefined && !isRecord(source.replication)) {
    throw fail("replication", source.replication, "must be an object");
  }
  const checked = new Map<string, unknown>();
  for (const key of CHANGEABLE) {
    const value = getIn(source, key);
    if (value === undefined) continue;
    try {
      checked.set(key, CHECKS[key](value));
    } catch (error) {
      throw fail(key, value, messageOf(error));
    }
  }
  return checked;
}

/**
 * Overlay the layers on the defaults. Layers are already checked, so values
 * are only looked up here.
 */
function assemble(dataDir: string, file: Raw, env: Raw): Config {
  const at = <T>(key: string): T => {
    for (const layer of [env, file]) {
      const value = getIn(layer, key);
      if (value !== undefined) return value as T;
    }
    return structuredClone(getIn(DEFAULTS, key)) as T;
  };

  return {
    owner: at<string | undefined>("owner"),
    hostname: at("hostname"),
    port: at("port"),
    dataDir,
    publicUrl: at<string | undefined>("publicUrl"),
    name: at("name"),
    description: at("description"),
    replication: {
      enabled: at("replication.enabled"),
      hops: at("replication.hops"),
      maxAuthors: at("replication.maxAuthors"),
      horizonDays: at("replication.horizonDays"),
      bootstrapRelays: at("replication.bootstrapRelays"),
      maxRelays: at("replication.maxRelays"),
      forward: at("replication.forward"),
      allowPrivateRelays: at("replication.allowPrivateRelays"),
    },
    store: buildStore(dataDir, env),
    blossom: {
      enabled: at("blossom.enabled"),
      maxBlobSize: at("blossom.maxBlobSize"),
    },
    publicSparql: at("publicSparql"),
    nostrConnect: at("nostrConnect"),
    maxLimit: at("maxLimit"),
  };
}

/**
 * The graph store: qlever-dir or a SPARQL endpoint when one is configured,
 * else embedded.
 */
function buildStore(dataDir: string, env: Raw): StoreConfig {
  const qleverUrl = getIn(env, "store.qleverUrl");
  if (typeof qleverUrl === "string") {
    const graphDir = getIn(env, "store.qleverGraphDir");
    const baseUri = getIn(env, "store.qleverBaseUri");
    return {
      kind: "qlever-dir",
      queryUrl: qleverUrl,
      graphDir: typeof graphDir === "string"
        ? graphDir
        : join(dataDir, "graph"),
      baseUri: typeof baseUri === "string" ? baseUri : DEFAULT_QLEVER_BASE_URI,
    };
  }
  const queryUrl = getIn(env, "store.queryUrl");
  if (typeof queryUrl !== "string") return { kind: "embedded" };

  const updateUrl = getIn(env, "store.updateUrl");
  const credentials = getIn(env, "store.credentials");
  return {
    kind: "sparql",
    queryUrl,
    updateUrl: typeof updateUrl === "string" ? updateUrl : queryUrl,
    ...(typeof credentials === "string" ? { credentials } : {}),
  };
}

/** The JSON text of `config.json`: only the changeable settings. */
function serializeSettings(file: Raw): string {
  const out: Raw = {};
  for (const key of CHANGEABLE) setIn(out, key, getIn(file, key));
  return JSON.stringify(out, null, 2) + "\n";
}

/** Write a temporary file beside `path`, then rename it over `path`. */
async function writeFileAtomic(path: string, text: string): Promise<void> {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await Deno.writeTextFile(temporary, text);
  try {
    await Deno.rename(temporary, path);
  } catch (error) {
    await Deno.remove(temporary).catch(() => {});
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Environment converters
// ---------------------------------------------------------------------------

function parseText(raw: string): string {
  return raw;
}

function parseInteger(raw: string): number {
  if (!/^-?\d+$/.test(raw)) throw new Error("must be an integer");
  return Number(raw);
}

function parseMegabytes(raw: string): number {
  return parseInteger(raw) * MEGABYTE;
}

/** A comma-separated list; empty items are dropped. */
function parseList(item: Parse): Parse {
  return (raw) =>
    raw
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part !== "")
      .map(item);
}

/** `on`, `true` and `1` enable; `off`, `false` and `0` disable. */
function parseToggle(raw: string): boolean {
  const word = raw.toLowerCase();
  if (word === "on" || word === "true" || word === "1") return true;
  if (word === "off" || word === "false" || word === "0") return false;
  throw new Error('must be "on", "off", "true", "false", "1" or "0"');
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

function checkText(value: unknown): string {
  if (typeof value !== "string") throw new Error("must be a string");
  return value;
}

function checkNonEmptyText(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("must not be empty");
  }
  return value.trim();
}

/** The graph IRI prefix of qlever-dir: an absolute http(s) URL ending in `/`. */
function checkBaseUri(value: unknown): string {
  if (typeof value !== "string") throw new Error("must be a string");
  const text = value.trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error("must be an absolute http or https URI ending with /");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !text.endsWith("/")
  ) {
    throw new Error("must be an absolute http or https URI ending with /");
  }
  return text;
}

function checkBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("must be true or false");
  return value;
}

function checkRange(min: number, max: number): Check {
  return (value) => {
    if (
      typeof value !== "number" || !Number.isInteger(value) ||
      value < min || value > max
    ) {
      throw new Error(`must be an integer from ${min} to ${max}`);
    }
    return value;
  };
}

function checkOneOf(options: readonly string[]): Check {
  return (value) => {
    if (typeof value !== "string" || !options.includes(value)) {
      throw new Error(`must be one of ${options.join(", ")}`);
    }
    return value;
  };
}

/** An `npub1…` or 64-character hex public key, returned as lower-case hex. */
function checkOwner(value: unknown): string {
  if (typeof value === "string") {
    const text = value.trim();
    if (/^[0-9a-fA-F]{64}$/.test(text)) return text.toLowerCase();
    if (text.startsWith("npub1")) {
      try {
        const decoded = nip19.decode(text);
        if (decoded.type === "npub") return decoded.data;
      } catch {
        // Reported below.
      }
    }
  }
  throw new Error("must be an npub or a 64-character hex public key");
}

/** An absolute http or https URL, without trailing slashes. */
function checkHttpUrl(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("must be an absolute http or https URL");
  }
  const text = value.trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error("must be an absolute http or https URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("must be an absolute http or https URL");
  }
  return text.replace(/\/+$/, "");
}

/** As {@link checkHttpUrl}, but the empty string means no public URL. */
function checkPublicUrl(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim() === "") return undefined;
  return checkHttpUrl(value);
}

/** A `ws://` or `wss://` URL, normalized. */
function checkRelayUrl(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("must be a ws:// or wss:// URL");
  }
  const text = value.trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error("must be a ws:// or wss:// URL");
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("must be a ws:// or wss:// URL");
  }
  return normalizeURL(text);
}

function checkRelayUrls(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("must be a list of relay URLs");
  return value.map(checkRelayUrl);
}

function checkHorizonDays(value: unknown): number[] {
  if (
    !Array.isArray(value) || value.length === 0 ||
    !value.every((day) => Number.isInteger(day) && day >= 0)
  ) {
    throw new Error("must be a non-empty list of non-negative integers");
  }
  return value;
}

/** `user:password`. */
function checkCredentials(value: unknown): string {
  if (typeof value !== "string" || !value.includes(":")) {
    throw new Error("must be user:password");
  }
  return value;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Raw {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The value at a dotted path, or undefined when a step is missing. */
function getIn(source: unknown, key: string): unknown {
  let node = source;
  for (const part of key.split(".")) {
    if (!isRecord(node)) return undefined;
    node = node[part];
  }
  return node;
}

/** Sets a dotted path, creating intermediate records. `undefined` removes it. */
function setIn(target: Raw, key: string, value: unknown): void {
  const [head, ...rest] = key.split(".");
  if (rest.length === 0) {
    if (value === undefined) delete target[head];
    else target[head] = value;
    return;
  }
  const child = target[head];
  if (isRecord(child)) {
    setIn(child, rest.join("."), value);
  } else if (value !== undefined) {
    const fresh: Raw = {};
    target[head] = fresh;
    setIn(fresh, rest.join("."), value);
  }
}
