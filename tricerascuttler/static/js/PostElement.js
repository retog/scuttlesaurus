import { handleSsbLinks, mdToHtml, runQuery } from "./web-util.js";
import * as _feedAuthor from "./FeedAuthorElement.js";
import * as _postLink from "./PostLinkElement.js";

export class PostElement extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    handleSsbLinks(this.shadowRoot);
    const msgUri = this.getAttribute("src");
    //sparql endpoints might not preserve order: https://github.com/acoli-repo/conll-rdf/issues/43
    runQuery(`PREFIX ssb: <ssb:ontology:>
        SELECT ?timestamp ?text ?root ?author (GROUP_CONCAT(?reply ; SEPARATOR=",") as ?replies) WHERE {
          { SELECT * WHERE {
            <${msgUri}> ssb:timestamp ?timestamp;
                        ssb:content ?content;
                        ssb:author ?author.
            ?content ssb:text ?text.
            OPTIONAL {?content ssb:root ?root}
            OPTIONAL {?reply ssb:timestamp ?replyTimestamp; ssb:content [ ssb:root <${msgUri}> ]}
          } ORDER BY ?replyTimestamp }
          } GROUP BY ?timestamp ?text ?root ?author`).then((result) => {
      const bindings = result.results.bindings;
      if (!bindings[0]) {
        this.shadowRoot.innerHTML = `Don't know anything about ${msgUri}`;
      } else {
        const text = bindings[0].text?.value;
        this.shadowRoot.innerHTML = `
        <style>
        :host {
          display: flex;
          flex-direction: column;
          justify-content: center;
          align-items: center;
          background-color: lightgrey;
          border-style: solid;
          margin: 5pt;
          padding: 5pt;
        }
        #permalink {
          text-decoration: none;
        }
      </style>
            ${mdToHtml(text ?? "")}<br>
            ${
          new Date(parseInt(bindings[0].timestamp?.value)).toLocaleString()
        }<br>
            <ssb-feed-author src="${
          bindings[0].author.value
        }" mode="small" ></ssb-feed-author>
        ${
          bindings[0].root
            ? `In reply to <ssb-post-link href="${
              bindings[0].root.value
            }"></ssb-post-link><br>`
            : ""
        }
        ${
          bindings[0].replies.value.split(",").filter((s) => s != "").map(
            (reply) =>
              `Reply: <ssb-post-link href="${reply}"></ssb-post-link><br>`,
          ).join("")
        }
        <a id="permalink" href="/?uri=${msgUri}">🔗</a>`;
      }
    });
  }
}
window.customElements.define("ssb-post", PostElement);
