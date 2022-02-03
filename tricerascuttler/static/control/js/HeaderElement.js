import * as _Tabs from "./TabsElement.js";
export class HeaderElement extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });

    const template = `
      <ssb-tabs plainmenu>
          <ssb-tab href="/" label="⌂"></ssb-tab>
          <ssb-tab href="/followees.html" label="Following"></ssb-tab>
          <ssb-tab href="/peers.html" label="Peers"></ssb-tab>
          <ssb-tab id="query" href="/query.html" label="SPARQL"></ssb-tab>
      </ssb-tabs>
    `;
    this.shadowRoot.innerHTML = template;
  }
}
window.customElements.define("ssb-header", HeaderElement);
