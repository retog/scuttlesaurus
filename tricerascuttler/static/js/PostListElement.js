import * as _PostElement from "./PostElement.js";
import { runQuery } from "./web-util.js";

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
      margin: 5px;
    }

  
    </style>

    <div id="content">

    </div>

    `;
  }

  connectedCallback() {
    const contentDiv = this.shadowRoot.getElementById("content");
    this.getPostsAndAppend(contentDiv);
  }

  async getPosts(offset, limit) {
    const resultJson = await runQuery(
      this.query + `OFFSET ${offset} LIMIT ${limit}`,
    );
    return resultJson.results.bindings.map((binding) => binding.post.value);
  }

  async getPostsAndAppend(targetElement) {
    const observerOptions = {
      root: null,
      rootMargin: "0px",
      threshold: 0,
    };

    const observer = new IntersectionObserver((entries) => {
      entries.filter((entry) => entry.isIntersecting).forEach((entry) => {
        this.getPostsAndAppend(targetElement);
      });
    }, observerOptions);
    await this.getPosts(this.currentOffset, this.loadSize + 1).then(
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
          observer.disconnect();
          if (posts.length > this.loadSize) {
            const postsElts = this.shadowRoot.querySelectorAll(".post");
            const lastPost = postsElts[postsElts.length - 1];
            observer.observe(lastPost);
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
