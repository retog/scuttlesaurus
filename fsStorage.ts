import { filenameSafeAlphabetRFC3548 } from "./util.ts";

export function getFeedDir(feedKey: string) {
  return "data/feeds/" + filenameSafeAlphabetRFC3548(feedKey);
}

export async function lastMessage(feedKey: string) {
  try {
    let highest = -1;
    for await (const entry of Deno.readDir(getFeedDir(feedKey))) {
      const seq = parseInt(
        entry.name.substring(0, entry.name.length - ".json".length),
      );
      if (seq > highest) {
        highest = seq;
      }
    }
    return highest;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      // file or directory does not exist
      return 0;
    } else {
      // unexpected error, maybe permissions, pass it along
      throw error;
    }
  }
}
