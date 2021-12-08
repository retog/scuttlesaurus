import FeedsAgent, {
  Message,
} from "../scuttlesaurus/agents/feeds/FeedsAgent.ts";
import {
  FeedId,
  JSONValue,
  parseBlobId,
  parseFeedId,
  parseMsgKey,
} from "../scuttlesaurus/util.ts";

export default class SparqlStorer {
  constructor(
    public sparqlEndpointQuery: string,
    public sparqlEndpointUpdate: string,
  ) {}

  /** stored exsting and new messages in the triple store*/
  connectAgent(feedsAgent: FeedsAgent) {
    const processFeed = async (feedId: FeedId) => {
      const fromMessage = await this.firstUnrecordedMessage(feedId);
      const msgFeed = feedsAgent.getFeed(feedId, {
        fromMessage,
      });
      const graphFeed = msgsToSparql(msgFeed);
      for await (const sparqlStatement of graphFeed) {
        await this.runSparqlStatement(sparqlStatement);
      }
    };
    feedsAgent.subscriptions.forEach(processFeed);
    feedsAgent.subscriptions.addAddListener(processFeed);
  }
  private async runSparqlStatement(sparqlStatement: string) {
    const response = await fetch(this.sparqlEndpointUpdate, {
      "headers": {
        "Accept": "text/plain,*/*;q=0.9",
        "Content-Type": "application/sparql-update",
      },
      "body": sparqlStatement,
      "method": "POST",
    });
    if (response.status >= 300) {
      throw new Error(response.statusText);
    }
  }
  private async firstUnrecordedMessage(feedId: FeedId): Promise<number> {
    const query = `
    PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
    PREFIX ssb: <ssb:ontology:>
    
    SELECT ?author ?seq WHERE {
      ?msg rdf:type ssb:Message;
      ssb:author <${feedId.toUri()}>;
      ssb:seq ?seq.
    
    } ORDER BY DESC(?seq) LIMIT 1`;
    const response = await fetch(this.sparqlEndpointQuery, {
      "headers": {
        "Accept": "application/sparql-results+json,*/*;q=0.9",
        "Content-Type": "application/sparql-query",
      },
      "body": query,
      "method": "POST",
    });
    if (response.status >= 300) {
      throw new Error(response.statusText);
    }

    const resultJson = await response.json();
    if (resultJson.results.bindings.length === 1) {
      return parseInt(resultJson.results.bindings[0].seq.value) + 1;
    } else {
      return 1;
    }
  }

  //end clas
}

type RichMessage = Message & {
  value: { content: { type?: string } };
};

async function* msgsToSparql(feed: AsyncIterable<Message>) {
  for await (const msg of feed) {
    try {
      yield msgToSparql(msg as RichMessage);
    } catch (error) {
      console.error(`Transforming ${JSON.stringify(msg)}: ${error}`);
    }
  }
}

function msgToSparql(msg: RichMessage) {
  const msgUri = parseMsgKey(msg.key).toUri();
  const content = (msg.value).content;
  if (content.type) {
    return `
    PREFIX ssb: <ssb:ontology:>
    PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>

    INSERT DATA
        {
            <${msgUri}> rdf:type ssb:Message;
            ssb:seq ${msg.value.sequence};
            ssb:author <${feedIdToUri(msg.value.author as FeedIdStr)}>;
            ssb:content ${
      contentSerializers[content.type]
        ? `[${contentSerializers[content.type!](content)}].`
        : `"${escapeLiteral(JSON.stringify(content))}".`
    }
        }`;
  } else {
    return `PREFIX ssb: <ssb:ontology:>
    PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>

    INSERT DATA {
            <${msgUri}> rdf:type <ssb:type:encrypted>
        }`;
  }
}

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
    expression: string;
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
  image?: string;
  description?: string;
  title?: string;
};

/**
 * functions that return the turtle/sparql predicates describning the content of a message
 */
const contentSerializers: Record<string, (content: JSONValue) => string> = {
  "post": ((
    content: Post,
  ) => {
    //console.log(JSON.stringify(content));
    return `rdf:type ssb:Post;
            ssb:text "${escapeLiteral(content.text)}"
            ${content.root ? `;\nssb:root <${msgKeyToUri(content.root)}>` : ""}
        ${
      content.reply && Object.entries(content.reply).length > 0
        ? ";\n" + Object.entries(content.reply).map(([p, _a]) =>
          `ssb:reply <${msgKeyToUri(p)}>`
        ).join(";\n")
        : ""
    }
    ${
      content.mentions && Object.entries(content.mentions).length > 0
        ? ";\n" + content.mentions.map((mention) =>
          `ssb:mention [${mentionAsTurtlePredicates(mention)}]`
        ).join(";\n")
        : ""
    }  
            `;
  }) as (content: JSONValue) => string,
  "contact": ((content: Contact) => {
    console.log(JSON.stringify(content));
    return `
    rdf:type ssb:Contact;
    ssb:contact <${feedIdToUri(content.contact)}>
    ${content.following ? `;\nssb:following ${content.following}` : ""}
    ${content.autofollow ? `;\nssb:autofollow ${content.autofollow}` : ""}
    ${content.blocking ? `;\nssb:blocking ${content.blocking}` : ""}
    `;
  }) as (content: JSONValue) => string,
  "vote": ((content: Vote) => {
    console.log(JSON.stringify(content));
    return `
      rdf:type ssb:Vote;
      ${content.vote.value ? `rdf:value ${content.vote.value};` : ""}
      ssb:expression "${escapeLiteral(content.vote.expression)}";
      ssb:link <${sigilToIri(content.vote.link)}>`;
  }) as (content: JSONValue) => string,
  "about": ((content: About) => {
    console.log(JSON.stringify(content));
    return `
      rdf:type ssb:About;
      ssb:about <${sigilToIri(content.about)}>${
      content.description
        ? `;
      ssb:description "${escapeLiteral(content.description)}"`
        : ""
    }${
      content.image
        ? `;
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
  }) as (content: JSONValue) => string,
};

function mentionAsTurtlePredicates(mention: Mention) {
  return `
        a ssb:Link;
        ssb:target <${sigilToIri(mention.link)}>
        `;
}

function msgKeyToUri(key: string) {
  return parseMsgKey(key).toUri();
}
function feedIdToUri(feedId: FeedIdStr) {
  return parseFeedId(feedId).toUri();
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
