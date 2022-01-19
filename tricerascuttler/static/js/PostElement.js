import { handleSsbLinks, mdToHtml, runQuery } from "./web-util.js";
import * as _feedAuthor from "./FeedAuthorLinkElement.js";
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
        img {
          max-width: 100%;
        }
        :host {
          display: block;
          border-style: solid;
          margin: 5pt;
          padding: 5pt;
        }
        #permalink {
          text-decoration: none;
        }

        ssb-feed-author-link {
          float: right;
          background-color: white;
          border-bottom-left-radius: 10px;
          padding: 5px;
          box-shadow: -9px 7px 8px rgba(139, 138, 138, 0.1);
        }
      </style>
      <ssb-feed-author-link feed="${
        bindings[0].author.value
      }" image ></ssb-feed-author-link>
            ${mdToHtml(text ?? "")}<br>
            ${
          new Date(parseInt(bindings[0].timestamp?.value)).toLocaleString()
        }<br>
            
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
