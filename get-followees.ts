import * as FSStorage from "./fsStorage.ts";
import { path } from "./util.ts";

if (Deno.args.length < 1) {
  throw new Error("expecting at least one argument");
}

const feedId = Deno.args[0]; // "@+qNos2XP9dfREX8qgNeA7V/KZPEYkRwreIuDqTWIqOI=.ed25519"

function strip(feedId: string) {
  if (feedId.startsWith("@") && feedId.endsWith(".ed25519")) {
    return feedId.substring(1, feedId.length - 8);
  } else {
    console.log(feedId + " doesn't seems to be dressed");
    return feedId;
  }
}

const feedKey = strip(feedId);

const subScriptions = new Set();

const lastMessage = await FSStorage.lastMessage(feedKey);
for (let i = 1; i < lastMessage; i++) {
  const fileName = path.join(
    FSStorage.getFeedDir(feedKey),
    i + ".json",
  );
  try {
    const parsedFile = JSON.parse(
      await Deno.readTextFile(fileName),
    );
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
      //console.log(`File ${fileName} not found, ending stream`);
      continue;
    }
  }
}

/*for (const entry of subScriptions) {
  console.log(entry);
}*/
console.log(JSON.stringify([...subScriptions]));
