import { Message } from "../scuttlesaurus/agents/feeds/FeedsAgent.ts";
import {
  log,
  parseBlobId,
  parseFeedId,
  parseMsgKey,
} from "../scuttlesaurus/util.ts";

type FeedIdStr = `@${string}.ed25519`;
type Mention = {
  link: string;
  name: string;
};
type Post = {
  type: "post";
  root?: string;
  fork?: string;
  branch?: string;
  reply?: Record<string, FeedIdStr>;
  channel?: string | string[] | null;
  recps?: null | string[];
  text: string;
  mentions: Mention[];
};
type Vote = {
  type: "vote";
  vote: {
    link: string;
    value: number;
    expression?: string;
  };
};
type Contact = {
  type: "contact";
  contact: FeedIdStr;
  following: boolean;
  autofollow?: boolean;
  blocking?: boolean;
};
type About = {
  type: "about";
  about: string;
  name?: string;
  image?: string | { link: string };
  description?: string;
  title?: string;
};
type OldSchoolAddress = { host: string; port: number; key: FeedIdStr };
type Pub = {
  type: "pub";
  address: string | OldSchoolAddress;
};

export type RichMessage = Message & {
  value: {
    content: { type?: string } | Post | Vote | Contact | About | Pub;
    timestamp: number;
  };
};
export default function msgToSparql(msg: RichMessage) {
  const msgUri = parseMsgKey(msg.key).toUri();
  const timestamp = msg.value.timestamp;
  const content = msg.value.content;
  abstract class StatementGenerator {
    abstract get insertDataContent(): string;
    generate() {
      return `
      PREFIX ssb: <ssb:ontology:>
      PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
  
      INSERT DATA {
              ${this.insertDataContent}
       }
    `;
    }
  }

  class BasicMessage extends StatementGenerator {
    get insertDataContent(): string {
      const safeContent = (() => {
        try {
          return this.content;
        } catch (error) {
          log.error(
            `Failed converting ${
              JSON.stringify(content)
            } to sparql: ${error}.`,
          );
          return undefined;
        }
      })();
      return `
        <${msgUri}> rdf:type ssb:Message;
        ssb:seq ${msg.value.sequence};
        ssb:timestamp ${timestamp};
        ssb:author <${feedIdToUri(msg.value.author as FeedIdStr)}>;
        ssb:raw "${escapeLiteral(JSON.stringify(content))}"
        ${
        safeContent
          ? `; ssb:content <content:${msgUri}>. <content:${msgUri}> ${safeContent}`
          : ""
      }.
      `;
    }
    get content(): string | undefined {
      return undefined;
    }
  }

  function feedIdToUri(feedId: FeedIdStr) {
    const [key, cypher] = feedId.trim().split(".");
    if (cypher !== "ed25519") {
      return `ssb:feed/${cypher}/${
        key.substring(1).replaceAll("/", "_").replaceAll("+", "-")
      }`.replaceAll("}", encodeURIComponent("}")); //TODO make safety more generic
    }
    return parseFeedId(feedId).toUri();
  }

  const contentSerializers: Record<string, StatementGenerator> = {
    "post": new class extends BasicMessage {
      get content() {
        const content = msg.value.content as Post;
        return `rdf:type ssb:Post;
            ssb:text "${escapeLiteral(content.text)}"
            ${content.root ? `;\nssb:root <${msgKeyToUri(content.root)}>` : ""}
            ${content.fork ? `;\nssb:fork <${msgKeyToUri(content.fork)}>` : ""}
        ${
          content.reply && Object.entries(content.reply).length > 0
            ? ";\n" + Object.entries(content.reply).map(([p, _a]) =>
              `ssb:reply <${msgKeyToUri(p)}>`
            ).join(";\n")
            : ""
        }
    ${
          content.mentions && Object.entries(content.mentions).length > 0
            ? ";\n" + content.mentions.map((mention, index) =>
              `ssb:mention <mention:${msgUri}/${index}>. <mention:${msgUri}/${index}> ${
                mentionAsTurtlePredicates(mention)
              }`
            ).join(";\n")
            : ""
        }  
            `;
      }
    }(),
    "contact": new class extends BasicMessage {
      get content() {
        const content = msg.value.content as Contact;
        return `
    rdf:type ssb:Contact;
    ssb:contact <${feedIdToUri(content.contact)}>
    ${
          typeof (content.following) === "boolean"
            ? `;\nssb:following ${content.following}`
            : ""
        }
    ${
          typeof (content.autofollow) === "boolean"
            ? `;\nssb:autofollow ${content.autofollow}`
            : ""
        }
    ${
          typeof (content.blocking) === "boolean"
            ? `;\nssb:blocking ${content.blocking}`
            : ""
        }
    `;
      }
      generate(): string {
        const content = msg.value.content as Contact;
        if (typeof (content.following) !== "boolean") {
          return super.generate();
        }
        const shortcutTriple = `<${
          feedIdToUri(msg.value.author as FeedIdStr)
        }> ssbx:follows <${feedIdToUri(content.contact)}> .`;
        if (content.following) {
          return `
          ${super.generate()};
          PREFIX ssbx: <ssb:ontology:derivatives:>
          INSERT DATA {
            ${shortcutTriple}
          }
          `;
        } else {
          return `
          ${super.generate()};
          PREFIX ssbx: <ssb:ontology:derivatives:>
          DELETE DATA {
            ${shortcutTriple}
          }
          `;
        }
      }
    }(),
    "vote": new class extends BasicMessage {
      get content() {
        const content = msg.value.content as Vote;
        return `
      rdf:type ssb:Vote;
      ${content.vote.value ? `rdf:value ${content.vote.value};` : ""}
      ${
          content.vote.expression
            ? `ssb:expression "${escapeLiteral(content.vote.expression)}";`
            : ""
        }
      ssb:link <${sigilToIri(content.vote.link)}>`;
      }
    }(),
    "about": new class extends BasicMessage {
      get content() {
        const content = msg.value.content as About;
        return `
      rdf:type ssb:About;
      ssb:about <${sigilToIri(content.about)}>${
          content.description
            ? `;
      ssb:description "${escapeLiteral(content.description)}"`
            : ""
        }${
          content.image
            ? typeof (content.image) !== "string"
              ? `;
        ssb:image <${sigilToIri(content.image.link)}>`
              : `;
      ssb:image <${sigilToIri(content.image)}>`
            : ""
        }${
          content.name
            ? `;
      ssb:name "${escapeLiteral(content.name)}"`
            : ""
        }${
          content.title
            ? `;
      ssb:title "${escapeLiteral(content.title)}"`
            : ""
        }
    `;
      }
    }(),
    "pub": new class extends BasicMessage {
      get content() {
        const content = msg.value.content as Pub;
        const oldSchool2String = (old: OldSchoolAddress) =>
          `net:${old.host}:${old.port}~shs:${parseFeedId(old.key).base64Key}`;
        const address = typeof content.address === "string"
          ? content.address
          : oldSchool2String(content.address as OldSchoolAddress);
        return `
      rdf:type ssb:Pub;
      ssb:address "${escapeLiteral(address)}"`;
      }
    }(),
  };

  function mentionAsTurtlePredicates(mention: Mention) {
    return `
        a ssb:Link;
        ssb:target <${
      sigilToIri(typeof (mention) === "string" ? mention : mention.link)
    }>
        `;
  }

  function msgKeyToUri(key: string) {
    return parseMsgKey(key).toUri();
  }

  function sigilToIri(sigil: string) {
    switch (sigil[0]) {
      case "@":
        return parseFeedId(sigil).toUri();
      case "&":
        return parseBlobId(sigil).toUri();
      case "%":
        return parseMsgKey(sigil).toUri();
      case "#":
        return `ssb:tag/${encodeURIComponent(sigil.substring(1))}`;
      default:
        throw new Error("unrecognized sigil type: " + sigil);
    }
  }

  function escapeLiteral(text: string) {
    return text.replaceAll("\\", "\\\\")
      .replaceAll('"', '\\"')
      .replaceAll("\n", "\\n").replaceAll("\r", "");
  }
  const statementGenerator = content.type && contentSerializers[content.type];
  if (statementGenerator) {
    try {
      return statementGenerator.generate();
    } catch (e) {
      log.info(`Caught ${e}, failing back to BasicMessage`);
    }
  }
  return new BasicMessage().generate();
}