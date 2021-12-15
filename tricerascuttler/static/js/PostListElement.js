import * as _PostElement from "./PostElement.js";

async function getPosts(query) {
  const response = await fetch("/query", {
    "headers": {
      "Accept": "application/sparql-results+json,*/*;q=0.9",
      "Content-Type": "application/sparql-query",
    },
    "body": query + " LIMIT 50",
    "method": "POST",
  });
  if (response.status >= 300) {
    throw new Error(response.statusText);
  }

  const resultJson = await response.json();
  return resultJson.results.bindings.map((binding) => binding.post.value);
}

export class PostListElement extends HTMLElement {
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
    getPosts(query).then(
      (posts) => {
        if (posts.length > 0) {
          template += `<h2>${posts.length} posts</h2>
          <div class="contacts">
          ${
            [...posts].map((p) =>
              `<ssb-post src="${p}" class="contact"></ssb-post>`
            ).join("")
          }
          </div>`;
        } else {
          template += `No posts found with given query: <code><pre>${
            query.replaceAll("<", "&lt;")
          }</pre></code>`;
        }
        this.shadowRoot.innerHTML = template;
      },
    );
  }
}
window.customElements.define("ssb-post-list", PostListElement);
