import FSStorage from "./storage/FsStorage.ts";
import { parseFeedId, path } from "./util.ts";

if (Deno.args.length < 1) {
  throw new Error("expecting at least one argument");
}

const args = new Array(...Deno.args);

const follow = args.indexOf("--follow") > -1;
if (follow) {
  args.splice(Deno.args.indexOf("--follow"), 1);
}
//TODO make configurable
const baseDir = path.join(Deno.env.get("HOME")!, ".ssb/");
const dataDir = path.join(baseDir, "data/");
const feedId = args[0]; // "@+qNos2XP9dfREX8qgNeA7V/KZPEYkRwreIuDqTWIqOI=.ed25519"

const feedKey = parseFeedId(feedId);

const subScriptions = new Set() as Set<string>;
const fsStorage = new FSStorage(dataDir);
const lastMessage = await fsStorage.lastMessage(feedKey);
for (let i = 1; i < lastMessage; i++) {
  try {
    const parsedFile = await fsStorage.getMessage(feedKey, i);
    const value = parsedFile.value;
    if (value!.content!.type === "contact") {
      if (value.content.following) {
        subScriptions.add(value.content.contact);
      } else {
        subScriptions.delete(value.content.contact);
      }
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      //console.info(`File ${fileName} not found, ending stream`);
      continue;
    }
  }
}

/*for (const entry of subScriptions) {
  console.info(entry);
}*/
console.info(JSON.stringify([...subScriptions]));
if (follow) {
  const textEncoder = new TextEncoder();
  const followeesFile = path.join(baseDir, "followees.json");

  console.info(`Adding feeds to ${followeesFile}`);

  const getFollowees = () => {
    try {
      return JSON.parse(Deno.readTextFileSync(followeesFile));
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return [];
      }
      throw error;
    }
  };
  const existing: string[] = getFollowees();
  existing.forEach((element) => {
    subScriptions.delete(element);
  });
  existing.push(...subScriptions);
  Deno.writeFileSync(
    followeesFile,
    textEncoder.encode(JSON.stringify(existing, undefined, 2)),
  );
  console.info(`Now following ${existing.length} feeds`);
}
