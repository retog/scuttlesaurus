/**
 * Fills a running node with a small, believable social world: profiles,
 * follows, notes, replies, reactions, articles, comments and media. The seed
 * is an external Nostr client; it talks to the node over its public interfaces
 * only. The world is described in `scripts/seed/world.ts`, and its people,
 * texts and articles live in `scripts/seed/data/`.
 *
 * Run with `deno task seed -- [--url http://127.0.0.1:7777] [--owner <handle>|hub] [--quiet]`.
 * Exit code 0 when everything was accepted or refused as designed, 1 when the
 * node could not be reached or some events failed unexpectedly, 2 for a bad
 * command line.
 *
 * @module
 */
import { NodeUnreachableError } from "./seed/client.ts";
import { parseOptions, USAGE, UsageError } from "./seed/options.ts";
import { formatSummary, seedNode } from "./seed/publish.ts";

/** Runs the seed with the command-line arguments and returns the exit code. */
export async function main(args: readonly string[]): Promise<number> {
  let options;
  try {
    options = parseOptions(args);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`seed: ${error.message}\n\n${USAGE}`);
      return 2;
    }
    throw error;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  try {
    const report = await seedNode(options);
    for (const line of formatSummary(report)) console.log(line);
    return report.events.failed > 0 || report.blobs.failed > 0 ? 1 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof NodeUnreachableError) {
      console.error(
        `seed: cannot reach the node at ${options.url}: ${message}`,
      );
    } else {
      console.error(`seed: ${message}`);
    }
    return 1;
  }
}

if (import.meta.main) {
  Deno.exit(await main(Deno.args));
}
