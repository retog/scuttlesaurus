/**
 * Command-line options of the seed: `--url`, `--owner` and `--quiet`.
 * @module
 */
import { PEOPLE } from "./data/people.ts";

/** Where the seed publishes when no `--url` is given. */
export const DEFAULT_URL = "http://127.0.0.1:7777";

/** The owner when no `--owner` is given. */
export const DEFAULT_OWNER = "mara";

/** The help text. */
export const USAGE =
  `Usage: deno task seed -- [--url <url>] [--owner <handle>|hub] [--quiet]

  --url <url>      the node to seed (default ${DEFAULT_URL})
  --owner <name>   the owner: a persona's handle, or hub (default ${DEFAULT_OWNER})
  --quiet, -q      print only the summary
  --help, -h       print this help`;

/** The parsed options. */
export interface CliOptions {
  readonly url: string;
  readonly owner: string;
  readonly quiet: boolean;
  readonly help: boolean;
}

/** A command line the seed does not accept. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/**
 * Parses the arguments after the script name. Accepts `--url value` and
 * `--url=value`. Throws {@link UsageError} for anything unknown or invalid.
 */
export function parseOptions(args: readonly string[]): CliOptions {
  let url = DEFAULT_URL;
  let owner = DEFAULT_OWNER;
  let quiet = false;
  let help = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    // `deno task seed -- --url …` may pass the separator on as an argument.
    if (arg === "--") continue;
    const [name, inline] = arg.startsWith("--") && arg.includes("=")
      ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
      : [arg, undefined];
    const value = () => {
      if (inline !== undefined) return inline;
      const next = args[++i];
      if (next === undefined || next.startsWith("--")) {
        throw new UsageError(`${name} needs a value`);
      }
      return next;
    };
    switch (name) {
      case "--url":
        url = value();
        break;
      case "--owner":
        owner = value();
        break;
      case "--quiet":
      case "-q":
        quiet = true;
        break;
      case "--help":
      case "-h":
        help = true;
        break;
      default:
        throw new UsageError(`unknown argument ${arg}`);
    }
  }
  validateUrl(url);
  if (owner !== "hub" && !PEOPLE.some((p) => p.handle === owner)) {
    throw new UsageError(`unknown owner ${owner}`);
  }
  return { url, owner, quiet, help };
}

function validateUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UsageError(`not a URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new UsageError(`the node URL must be http or https: ${url}`);
  }
}
