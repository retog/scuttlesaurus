import FeedsAgent, {
  Message,
} from "../scuttlesaurus/agents/feeds/FeedsAgent.ts";
import { delay, FeedId, log } from "../scuttlesaurus/util.ts";

import msgToSparql, { RichMessage } from "./msgToSparql.ts";

export default class SparqlStorer {
  constructor(
    public sparqlEndpointQuery: string,
    public sparqlEndpointUpdate: string,
  ) {}

  /** stored exsting and new messages in the triple store*/
  connectAgent(feedsAgent: FeedsAgent) {
    const processMsg = async (msg: Message) => {
      const sparqlStatement = msgToSparql(msg as RichMessage);
      try {
        await this.runSparqlStatementSequential(sparqlStatement);
      } catch (error) {
        log.error(
          `Failed inserting message with sparql, ignoring: ${error}. Stack: ${error.stack}`,
        );
      }
    };
    const processFeed = async (feedId: FeedId) => {
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

    Promise.all([...feedsAgent.subscriptions].map(processFeed)).catch(
      (error) => {
        console.error(`Processing feeds: ${error}`);
      },
    );

    feedsAgent.addNewMessageListeners((_feedId: FeedId, msg: Message) => {
      processMsg(msg);
    });
    //feedsAgent.subscriptions.addAddListener(processFeed);
  }

  /*  lastRun: Promise<void> = Promise.resolve();

  private async runSparqlStatementSequential(sparqlStatement: string) {
    //retrying connection because of "connection closed before message completed"-errors
    const tryRunSparqlStatement = (attemptsLeft = 5) => {
      this.lastRun = (async () => {
        try {
          await this.runSparqlStatement(sparqlStatement);
        } catch (error) {
          if (attemptsLeft === 0) {
            log.error(`Running SPARQL Update: ${error}`);
          } else {
            await delay(10000);
            await tryRunSparqlStatement(attemptsLeft - 1);
          }
        }
      })();
    };
    await this.lastRun;
    tryRunSparqlStatement();
    //reduce the write load to increase chances that reads still succeed
    await delay(10000);
    await this.lastRun;
  }*/

  semaphore: Promise<void> = Promise.resolve();

  private async runSparqlStatementSequential(sparqlStatement: string) {
    while (true) {
      const semaphore = this.semaphore;
      await semaphore;
      if (semaphore === this.semaphore) {
        break;
      }
    }
    this.semaphore = this.runSparqlStatement(sparqlStatement);
    await this.semaphore;
  }

  private async runSparqlStatement(sparqlStatement: string) {
    await delay(100);
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
    await response.arrayBuffer();
  }
  private async firstUnrecordedMessage(feedId: FeedId): Promise<number> {
    const query = `
    PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
    PREFIX ssb: <ssb:ontology:>
    
    SELECT ?next WHERE {
      {
        ?msg rdf:type ssb:Message;
           ssb:author <${feedId.toUri()}>;
          ssb:seq ?seq.
      } UNION {
        BIND (0 AS ?seq)
      }
      BIND((?seq+1) AS ?next)
      MINUS  {
        ?otherMsg rdf:type ssb:Message;
           ssb:author <${feedId.toUri()}>;
          ssb:seq ?next.
      }
    } ORDER BY ASC(?seq) LIMIT 1`;
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
      return parseInt(resultJson.results.bindings[0].next.value);
    } else {
      return 1;
    }
  }
}
