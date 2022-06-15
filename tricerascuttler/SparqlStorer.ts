import FeedsAgent, {
  Message,
} from "../scuttlesaurus/agents/feeds/FeedsAgent.ts";
import FeedsStorage from "../scuttlesaurus/storage/FeedsStorage.ts";
import { delay, FeedId, JSONValue } from "../scuttlesaurus/util.ts";

import msgToSparql, { RichMessage } from "./msgToSparql.ts";

export default class SparqlStorer implements FeedsStorage {
  constructor(
    public sparqlEndpointQuery: string,
    public sparqlEndpointUpdate: string,
    public credentials: string | undefined,
  ) {}

  async storeMessage(
    feedId: FeedId,
    position: number,
    msg: JSONValue,
  ): Promise<void> {
    if (await this.messageExists(feedId, position)) {
      throw new Error("A message with that feed and position already exist");
    }
    const insertDelete = msgToSparql(msg as RichMessage);
    const sparqlStatement = `
      PREFIX ssb: <ssb:ontology:>
      PREFIX ssbx: <ssb:ontology:derivatives:>
      PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>

      DELETE  {
        ${insertDelete.deleteClause}
      }
      INSERT {
        ${insertDelete.insertClause}
      }
      WHERE {
        OPTIONAL {?x ssb:seq ${position}; ssb:author <${feedId.toUri()}>.}
        FILTER (!BOUND(?x))
      }`;
    await this.runSparqlStatementSequential(sparqlStatement);
  }

  private async messageExists(
    feedId: FeedId,
    position: number,
  ): Promise<boolean> {
    const query = `
      PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
      PREFIX ssb: <ssb:ontology:>
      ASK {
        {?x ssb:seq ${position}; ssb:author <${feedId.toUri()}>.}
      }
      `;
    const headers: Record<string, string> = {
      "Accept": "application/sparql-results+json,*/*;q=0.9",
      "Content-Type": "application/sparql-query",
    };
    if (this.credentials) {
      headers.Authorization = `Basic ${btoa(this.credentials)}`;
    }
    const fetchResult = fetch(this.sparqlEndpointQuery, {
      headers,
      "body": query,
      "method": "POST",
    });
    const response = await fetchResult;
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`${body}`);
    }

    const resultJson = await response.json();
    return resultJson.value;
  }

  async getMessage(feedId: FeedId, position: number): Promise<Message> {
    const query = `
    PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
    PREFIX ssb: <ssb:ontology:>
    
    SELECT ?raw WHERE {
      {
        ?msg rdf:type ssb:Message;
          ssb:author <${feedId.toUri()}>;
          ssb:seq ${position};
          ssb:raw ?raw.
      }
    }`;
    const headers: Record<string, string> = {
      "Accept": "application/sparql-results+json,*/*;q=0.9",
      "Content-Type": "application/sparql-query",
    };
    if (this.credentials) {
      headers.Authorization = `Basic ${btoa(this.credentials)}`;
    }
    const fetchResult = fetch(this.sparqlEndpointQuery, {
      headers,
      "body": query,
      "method": "POST",
    });
    const response = await fetchResult;
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`${body}`);
    }

    const resultJson = await response.json();
    if (resultJson.results.bindings.length === 1) {
      return JSON.parse(resultJson.results.bindings[0].raw.value);
    } else {
      throw new Error("No such message");
    }
  }

  async lastMessage(feedId: FeedId): Promise<number> {
    const query = `
    PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
    PREFIX ssb: <ssb:ontology:>
    
    SELECT (MAX(?seq) as ?last) WHERE {
      {
        ?msg rdf:type ssb:Message;
           ssb:author <${feedId.toUri()}>;
          ssb:seq ?seq.
      }
    }`;
    const headers: Record<string, string> = {
      "Accept": "application/sparql-results+json,*/*;q=0.9",
      "Content-Type": "application/sparql-query",
    };
    if (this.credentials) {
      headers.Authorization = `Basic ${btoa(this.credentials)}`;
    }
    const fetchResult = fetch(this.sparqlEndpointQuery, {
      headers,
      "body": query,
      "method": "POST",
    });
    const response = await fetchResult;
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`${body}`);
    }

    const resultJson = await response.json();
    if (resultJson.results.bindings[0]?.last?.value) {
      return parseInt(resultJson.results.bindings[0].last.value);
    } else {
      return 0;
    }
  }

  /** stored exsting and new messages in the triple store*/
  connectAgent(feedsAgent: FeedsAgent) {
    const processMsg = async (msg: Message) => {
      const insertDelete = msgToSparql(msg as RichMessage);
      const sparqlStatement = `
      PREFIX ssb: <ssb:ontology:>
      PREFIX ssbx: <ssb:ontology:derivatives:>
      PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
  
      INSERT DATA {
              ${insertDelete.insertClause}
      };
      DELETE DATA {
              ${insertDelete.deleteClause}
      }
      `;
      try {
        await this.runSparqlStatementSequential(sparqlStatement);
      } catch (error) {
        console.error(
          `Failed inserting message with sparql, ignoring: ${error}. Stack: ${error.stack}`,
        );
      }
    };
    const processFeed = async (feedId: FeedId) => {
      await delay(100);
      const fromMessage = await this.firstUnrecordedMessage(feedId);
      const msgFeed = feedsAgent.getFeed(feedId, {
        fromMessage,
        newMessages: false,
      });
      for await (const msg of msgFeed) {
        await processMsg(msg);
        //reduce the write load to increase chances that reads still suceed
        await delay(100);
      }
    };

    (async () => {
      const subscriptions = [...feedsAgent.subscriptions];
      try {
        for (const subscription of subscriptions) {
          try {
            await processFeed(subscription);
          } catch (e) {
            console.info(`Processing subscription ${subscription}: ${e}`);
          }
        }
        /*const promiseResults = await Promise.allSettled(
          subscriptions.map(processFeed),
        );
        promiseResults.forEach((result, i) => {
          if (result.status === "rejected") {
            console.info(`Processing subscription ${subscriptions[i]}`);
          }
        });*/
      } catch (e) {
        console.error(`Processing subscriptions: ${e}`);
      }
    })();

    feedsAgent.addNewMessageListeners((_feedId: FeedId, msg: Message) => {
      processMsg(msg);
    });
    //feedsAgent.subscriptions.addAddListener(processFeed);
  }

  semaphore: Promise<unknown> = Promise.resolve();

  private async runSparqlStatementSequential(sparqlStatement: string) {
    while (true) {
      const semaphore = this.semaphore;
      try {
        await semaphore;
      } catch (_e) {
        //this should be handled by the concurrent invoker
      }
      if (semaphore === this.semaphore) {
        break;
      }
    }
    this.semaphore = this.runSparqlStatement(sparqlStatement);
    await this.semaphore;
  }

  private async runSparqlStatement(sparqlStatement: string) {
    await delay(100);
    const headers: Record<string, string> = {
      "Accept": "text/plain,*/*;q=0.9",
      "Content-Type": "application/sparql-update;charset=utf-8",
    };
    if (this.credentials) {
      headers.Authorization = `Basic ${btoa(this.credentials)}`;
    }
    const response = await fetch(
      this.sparqlEndpointUpdate,
      {
        headers,
        "body": sparqlStatement,
        "method": "POST",
        keepalive: false,
      },
    );
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`${body}\n${sparqlStatement}`);
    }
    /* this is to avoid:
error: Uncaught (in promise) TypeError: error sending request for url (http://fuseki:3330/ds/update): connection closed before message completed
    at async mainFetch (deno:ext/fetch/26_fetch.js:266:14)
    */
    await response.arrayBuffer();
  }
  private async firstUnrecordedMessage(feedId: FeedId): Promise<number> {
    const query = `
    PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
    PREFIX ssb: <ssb:ontology:>
    
    SELECT ?next WHERE {
      {
        ?msg rdf:type ssb:Message;
           ssb:author <${feedId.toUri()}>;
          ssb:seq ?seq.
      }
      BIND((?seq+1) AS ?next)
      MINUS  {
        ?otherMsg rdf:type ssb:Message;
           ssb:author <${feedId.toUri()}>;
          ssb:seq ?next.
      }
    } ORDER BY ASC(?seq) LIMIT 1`;
    const headers: Record<string, string> = {
      "Accept": "application/sparql-results+json,*/*;q=0.9",
      "Content-Type": "application/sparql-query",
    };
    if (this.credentials) {
      headers.Authorization = `Basic ${btoa(this.credentials)}`;
    }
    const fetchResult = fetch(this.sparqlEndpointQuery, {
      headers,
      "body": query,
      "method": "POST",
    });
    const response = await fetchResult;
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`${body}`);
    }

    const resultJson = await response.json();
    if (resultJson.results.bindings.length === 1) {
      return parseInt(resultJson.results.bindings[0].next.value);
    } else {
      return 1;
    }
  }
}
