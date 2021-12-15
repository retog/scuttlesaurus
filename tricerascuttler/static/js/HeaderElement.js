export class HeaderElement extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });

    const template = `
      <style>
      ul {
        list-style-type: none;
        margin: 0;
        padding: 0;
        overflow: hidden;
        background-color: #333;
      }

      li {
          float: left;
      }

      li a {
          display: block;
          color: white;
          text-align: center;
          padding: 14px 16px;
          text-decoration: none;
      }

      li a:hover {
          background-color: #111;
      }
      .active {
        background-color: #04AA6D;
      }
      </style>
      <ul>
          <li><a href="/">Explore</a></li>
          <li><a href="/read.html">Read</a></li>
          <li><a href="/followees.html">Following</a></li>
          <li><a href="/peers.html">Peers</a></li>
          <li><a id="query" href="/query.html">SPARQL</a></li>
          <li><a id="query" href="/about.html">About</a></li>
      </ul>
    `;
    this.shadowRoot.innerHTML = template;
    this.shadowRoot.querySelector(`a[href='${document.location.pathname}']`)
      .setAttribute("class", "active");
  }
}
window.customElements.define("ssb-header", HeaderElement);
