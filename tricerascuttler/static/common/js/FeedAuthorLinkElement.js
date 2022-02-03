import { getDescription } from "./FeedAuthorElement.js";

export class FeedAuthorLinkElement extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    const feedUri = this.getAttribute("feed");
    const showImage = this.hasAttribute("image");
    getDescription(feedUri).then(
      ({ name, description, image }) => {
        this.shadowRoot.innerHTML = `
      <style>
        :host {
          justify-content: right;
        }
    
        a {
          text-decoration: none;
          color: inherit;
        }

        img {
          max-width: 40px;
          max-height: 40px;
        }
      </style>
    
      <a href="/?uri=${feedUri}">
        ${
          showImage && image
            ? `<img src="${image.replace("ssb:blob/", "./blob/")}">`
            : ""
        }
        <div>${name ? name : feedUri.substring(0, 23) + "..."}</div></a>
    `;
      },
    );
  }
}
window.customElements.define("ssb-feed-author-link", FeedAuthorLinkElement);
