import FeedsAgent, {
  Message,
} from "../scuttlesaurus/agents/feeds/FeedsAgent.ts";
import {
  delay,
  FeedId,
  JSONValue,
  log,
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
        try {
          await this.runSparqlStatement(sparqlStatement);
        } catch (error) {
          log.error(`Failed inserting message with sparql, ignoring: ${error}`);
        }
        //reduce the write load to increade chances that reads still suceed
        await delay(100);
      }
    };

    Promise.all([...feedsAgent.subscriptions].map(processFeed)).catch(
      (error) => {
        console.error(`Procesing feeds: ${error}`);
      },
    );

    feedsAgent.subscriptions.addAddListener(processFeed);
  }

  lastRun: Promise<void> = Promise.resolve();
  private async runSparqlStatementSequential(sparqlStatement: string) {
    //retrying connection because of "connection closed before message completed"-errors
    const tryRunSparqlStatement = (attemptsLeft = 5) => {
      this.lastRun = this.runSparqlStatement(sparqlStatement).catch((error) => {
        if (attemptsLeft === 0) {
          log.error(`Running SPARQL Update: ${error}`);
        } else {
          tryRunSparqlStatement(attemptsLeft - 1);
        }
      });
    };
    await this.lastRun;
    tryRunSparqlStatement();
    //reduce the write load to increase chances that reads still succeed
    await delay(5);
    await this.lastRun;
  }

  private async runSparqlStatement(sparqlStatement: string) {
    const response = await fetch(this.sparqlEndpointUpdate, {
      "headers": {
        "Accept": "text/plain,*/*;q=0.9",
        "Content-Type": "application/sparql-update;charset=utf-8",
      },
      "body": sparqlStatement,
      "method": "POST",
      keepalive: false,
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`${body}\n${sparqlStatement}`);
    }
    /* this is to avoid:
error: Uncaught (in promise) TypeError: error sending request for url (http://fuseki:3330/ds/update): connection closed before message completed
    at async mainFetch (deno:ext/fetch/26_fetch.js:266:14)
    */
    //await response.arrayBuffer();
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
}

type RichMessage = Message & {
  value: {
    content: { type?: string };
    timestamp: number;
  };
};

async function* msgsToSparql(feed: AsyncIterable<Message>) {
  for await (const msg of feed) {
    try {
      yield msgToSparql(msg as RichMessage);
    } catch (error) {
      console.error(
        `Transforming ${
          JSON.stringify(msg)
        }: ${error}\nThe message will be ignored`,
      );
    }
  }
}

function msgToSparql(msg: RichMessage) {
  const msgUri = parseMsgKey(msg.key).toUri();
  const timestamp = msg.value.timestamp;
  const content = (msg.value).content;
  if (content.type) {
    return `
    PREFIX ssb: <ssb:ontology:>
    PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>

    INSERT DATA
    {
      <${msgUri}> rdf:type ssb:Message;
      ssb:seq ${msg.value.sequence};
      ssb:timestamp ${timestamp};
      ssb:author <${feedIdToUri(msg.value.author as FeedIdStr)}>;
      ${
      contentSerializers[content.type]
        ? `ssb:content [${contentSerializers[content.type!](content)}];`
        : `;`
    }
      ssb:raw "${escapeLiteral(JSON.stringify(content))}".
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

/**
 * functions that return the turtle/sparql predicates describning the content of a message
 */
const contentSerializers: Record<string, (content: JSONValue) => string> = {
  "post": ((
    content: Post,
  ) => {
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
  }) as (content: JSONValue) => string,
  "vote": ((content: Vote) => {
    return `
      rdf:type ssb:Vote;
      ${content.vote.value ? `rdf:value ${content.vote.value};` : ""}
      ${
      content.vote.expression
        ? `ssb:expression "${escapeLiteral(content.vote.expression)}";`
        : ""
    }
      ssb:link <${sigilToIri(content.vote.link)}>`;
  }) as (content: JSONValue) => string,
  "about": ((content: About) => {
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
  }) as (content: JSONValue) => string,
  "pub": ((content: Pub) => {
    const oldSchool2String = (old: OldSchoolAddress) =>
      `net:${old.host}:${old.port}~shs:${parseFeedId(old.key).base64Key}`;
    const address = typeof content.address === "string"
      ? content.address
      : oldSchool2String(content.address as OldSchoolAddress);
    return `
      rdf:type ssb:Pub;
      ssb:address "${escapeLiteral(address)}"`;
  }) as (content: JSONValue) => string,
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
function feedIdToUri(feedId: FeedIdStr) {
  const [key, cypher] = feedId.split(".");
  if (cypher !== "ed25519") {
    return `ssb:feed/${cypher}/${
      key.substring(1).replaceAll("/", "_").replaceAll("+", "-")
    }`;
  }
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
