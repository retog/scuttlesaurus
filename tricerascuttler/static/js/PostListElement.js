import * as _PostElement from "./PostElement.js";
import { ReadStateManager, runQuery } from "./web-util.js";

export class PostListElement extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });

    this.query = this.getAttribute("query");
    this.loadSize = parseInt(this.getAttribute("loadSize") ?? 20);
    this.styleElem = document.createElement("style");
    this.styleElem.innerHTML = `
    .post {
      display: block;
      margin: 5px;
    }
    .hideRead .read {
      display: none;
    }
    `;
    this.shadowRoot.appendChild(this.styleElem);
    this.shadowRoot.innerHTML += `
    <div id="filter">
      <select id="showRead">
        <option value="hideRead">Hide read messages</option>
        <option value="showAll">Show all messages</option>
        <option value="hideUnread">Hide unread messages</option>
      </select>
    </div>

    <div id="content">

    </div>

    `;
  }

  connectedCallback() {
    const contentDiv = this.shadowRoot.getElementById("content");
    const showReadSelect = this.shadowRoot.getElementById("showRead");
    const handleSelect = () => {
      this.hideRead = showReadSelect.value === "hideRead";
      this.hideUnread = showReadSelect.value === "hideUnread";
      if (this.hideRead) {
        contentDiv.classList.add("hideRead");
      } else {
        contentDiv.classList.remove("hideRead");
      }
      contentDiv.replaceChildren();
      this.getPostsAndAppend(0, contentDiv);
    };
    showReadSelect.addEventListener("change", handleSelect);
    handleSelect();
  }

  async getPosts(offset, limit) {
    console.log(`Getting post from ${offset} with limit ${limit}`);
    const resultJson = await runQuery(
      this.query + `OFFSET ${offset} LIMIT ${limit}`,
    );
    return resultJson.results.bindings.map((binding) => binding.post.value);
  }

  async getPostsAndAppend(offset, targetElement) {
    const observerOptions = {
      root: null,
      rootMargin: "0px",
      threshold: 0,
    };

    let expanding = false;
    const expand = () => {
      if (!expanding) {
        expanding = true;
        this.getPostsAndAppend(offset + this.loadSize, targetElement);
      }
    };
    const observer = new IntersectionObserver((entries) => {
      entries.filter((entry) => entry.isIntersecting).some((_entry) => {
        expand();
        return true;
      });
    }, observerOptions);

    observer.disconnect();

    await this.getPosts(offset, this.loadSize + 1).then(
      (posts) => {
        if (posts.length > 0) {
          const filteredPosts = [...posts].slice(0, this.loadSize).filter((p) =>
            !(this.hideRead && ReadStateManager.isRead(p))
          ).filter((p) => !(this.hideUnread && !ReadStateManager.isRead(p)));
          targetElement.insertAdjacentHTML(
            "beforeend",
            `<div class="posts">
            ${
              filteredPosts
                .map((p) => `<ssb-post src="${p}" class="post"></ssb-post>`)
                .join("")
            }
          </div>`,
          );
          if (filteredPosts.length === 0) {
            expand();
          } else if (posts.length > this.loadSize) {
            const postsElts = this.shadowRoot.querySelectorAll(".post");
            const lastPost = postsElts[postsElts.length - 1];
            observer.observe(lastPost);
          }
        } else {
          if (offset === 0) {
            targetElement.insertAdjacentHTML(
              "beforeend",
              `No posts found with given query: <code><pre>${
                this.query.replaceAll("<", "&lt;")
              }</pre></code>`,
            );
          } else {
            //This shouldn't happen as we don't search if there isn't one more post
            targetElement.insertAdjacentHTML(
              "beforeend",
              `No more posts.`,
            );
          }
        }
      },
    );
  }
}
window.customElements.define("ssb-post-list", PostListElement);
