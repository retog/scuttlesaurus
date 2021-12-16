import * as _PostElement from "./PostElement.js";

async function getPosts(query, offset, limit) {
  const response = await fetch("/query", {
    "headers": {
      "Accept": "application/sparql-results+json,*/*;q=0.9",
      "Content-Type": "application/sparql-query",
    },
    "body": query + `OFFSET ${offset} LIMIT ${limit}`,
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

    this.query = this.getAttribute("query");
    this.loadSize = parseInt(this.getAttribute("loadSize") ?? 20);

    this.currentOffset = 0;

    this.shadowRoot.innerHTML = `
    <style>
    .post {
      display: block;
      flex: 0 1 150px;
      margin: 5px;
    }
    .posts{
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
    }
  
    </style>

    <div id="content">

    </div>

    `;
    const contentDiv = this.shadowRoot.getElementById("content");
    this.getPostsAndAppend(contentDiv);
  }

  async getPostsAndAppend(targetElement) {
    await getPosts(this.query, this.currentOffset, this.loadSize + 1).then(
      (posts) => {
        this.currentOffset += this.loadSize;
        if (posts.length > 0) {
          targetElement.insertAdjacentHTML(
            "beforeend",
            `<div class="posts">
          ${
              [...posts].slice(0, this.loadSize).map((p) =>
                `<ssb-post src="${p}" class="post"></ssb-post>`
              ).join("")
            }
          </div>`,
          );
          if (posts.length > this.loadSize) {
            const showMoreButton = document.createElement("button");
            showMoreButton.innerHTML = "Show more";
            targetElement.appendChild(showMoreButton);
            showMoreButton.addEventListener("click", () => {
              targetElement.removeChild(showMoreButton);
              this.getPostsAndAppend(targetElement);
            });
          }
        } else {
          targetElement.insertAdjacentHTML(
            "beforeend",
            `No posts found with given query: <code><pre>${
              this.query.replaceAll("<", "&lt;")
            }</pre></code>`,
          );
        }
      },
    );
  }
}
window.customElements.define("ssb-post-list", PostListElement);
