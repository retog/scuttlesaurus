import { handleSsbLinks, mdToHtml, runQuery } from "./web-util.js";
import * as _feedAuthor from "./FeedAuthorElement.js";
import * as _postLink from "./PostLinkElement.js";

export class PostElement extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    handleSsbLinks(this.shadowRoot);
    const msgUri = this.getAttribute("src");
    runQuery(`PREFIX ssb: <ssb:ontology:>
        SELECT ?timestamp ?text ?root ?author WHERE {
            <${msgUri}> ssb:timestamp ?timestamp;
                        ssb:content ?content;
                        ssb:author ?author.
            ?content ssb:text ?text.
            OPTIONAL {?content ssb:root ?root}
        }`).then((result) => {
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
        <a id="permalink" href="/?uri=${msgUri}">🔗</a>`;
      }
    });
  }
}
window.customElements.define("ssb-post", PostElement);
