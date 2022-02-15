import * as _FeedAuth from "./FeedAuthorElement.js";
import { runQuery } from "./web-util.js";

async function getFeeds(query) {
  const resultJson = await runQuery(query);
  return resultJson.results.bindings.map((binding) => binding.feed.value);
}

export class FeedAuthorListElement extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });

    const query = this.getAttribute("query");

    let template = `
    <style>
    .contact {
      display: block;
      flex: 0 1 150px;
      margin: 5px;
    }
    .contacts{
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
    }
  
    </style>

    `;
    getFeeds(query).then(
      (feeds) => {
        if (feeds.length > 0) {
          template += `<h2>${feeds.length} feeds</h2>
          <div class="contacts">
          ${
            [...feeds].map((f) =>
              `<ssb-feed-author src="${f}" class="contact"></ssb-feed-author>`
            ).join("")
          }
          </div>`;
        } else {
          template += `No feeds found.`;
          console.log(
            `No feeds found with given query: >${
              query
            }`,
          );
        }

        this.shadowRoot.innerHTML = template;
      },
    );
  }
}
window.customElements.define("ssb-feed-author-list", FeedAuthorListElement);
