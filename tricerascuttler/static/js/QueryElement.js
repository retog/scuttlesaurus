import * as _Tabs from "https://unpkg.com/@triply/yasgui/build/yasgui.min.js";
export class QueryElement extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });

    this.shadowRoot.innerHTML = `
    <link href="https://unpkg.com/@triply/yasgui/build/yasgui.min.css" rel="stylesheet" type="text/css" />
    <div id="yasgui"></div>`;
    const yasgui = new Yasgui(this.shadowRoot.getElementById("yasgui"), {
      requestConfig: {
          endpoint: "./query",
          method: "GET"
      },
      copyEndpointOnNewTab: false,
  });
  }
}
window.customElements.define("ssb-query", QueryElement);
