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
      <link rel="stylesheet" href="/reset.css">
      <style>
        :host {
        }
    
        a {
          display: grid;
          gap: 0.2rem;
          grid-template-columns: ${showImage ? "2.4rem 1fr" : "1fr"};
          grid-template-rows: 1.2rem 1rem;
          padding: 0.2rem;
        }

        .name {
          font-size: 1rem;
          line-height: 1.2rem;
        }

        .uri {
          color: gray;
          font-size: 0.8rem;
          line-height: 1rem;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        img,
        svg {
          border-radius: 0.4rem;
          grid-area: 1 / 1 / 3 / 2;
          max-width: 100%;
          max-height: 100%;
        }
      </style>
    
      <a href="/?uri=${feedUri}">
        ${
          showImage && image
            ? `<img src="${image.replace("ssb:blob/", "./blob/")}">`
            : '<svg viewBox="0 0 24 24"><path fill="gray" d="M20,12A8,8 0 0,0 12,4A8,8 0 0,0 4,12A8,8 0 0,0 12,20A8,8 0 0,0 20,12M22,12A10,10 0 0,1 12,22A10,10 0 0,1 2,12A10,10 0 0,1 12,2A10,10 0 0,1 22,12M10,9.5C10,10.3 9.3,11 8.5,11C7.7,11 7,10.3 7,9.5C7,8.7 7.7,8 8.5,8C9.3,8 10,8.7 10,9.5M17,9.5C17,10.3 16.3,11 15.5,11C14.7,11 14,10.3 14,9.5C14,8.7 14.7,8 15.5,8C16.3,8 17,8.7 17,9.5M12,17.23C10.25,17.23 8.71,16.5 7.81,15.42L9.23,14C9.68,14.72 10.75,15.23 12,15.23C13.25,15.23 14.32,14.72 14.77,14L16.19,15.42C15.29,16.5 13.75,17.23 12,17.23Z" /></svg>'
        }
        <div class="name">${name || ""}</div>
        <div class="uri">${feedUri}</div>
      </a>
    `;
      },
    );
  }
}
window.customElements.define("ssb-feed-author-link", FeedAuthorLinkElement);
