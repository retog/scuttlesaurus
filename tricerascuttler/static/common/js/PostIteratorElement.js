import * as _PostElement from "./PostElement.js";
import { PostListElement } from "./PostListElement.js";
import { runQuery } from "./web-util.js";

export class PostIteratorElement extends PostListElement {
  posts = [];

  constructor() {
    super();
    this.anchor = this.getAttribute("anchor");
    this.step = this.getAttribute("step");
  }

  async nextPost() {
    const effQuery = this.step.replaceAll("??", `<${this.anchor}>`);
    const resultBindings = (await runQuery(effQuery)).results.bindings;
    if (resultBindings.length === 0) {
      //no more posts
      return;
    } else {
      const post = resultBindings[0].post.value;
      this.anchor = post;
      const show = JSON.parse(resultBindings[0].show.value);
      if (show) {
        return post;
      } else {
        return this.nextPost();
      }
    }
  }

  async getPosts(_offset, limit) {
    for (let i = 0; i < limit; i++) {
      this.posts[i] = await this.nextPost();
    }
    return this.posts;
  }
}
window.customElements.define("ssb-post-iter", PostIteratorElement);
