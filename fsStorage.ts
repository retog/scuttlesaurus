import { filenameSafeAlphabetRFC3548 } from "./util.ts";

export function getFeedDir(feedKey: string) {
  return "data/feeds/" + filenameSafeAlphabetRFC3548(feedKey);
}
