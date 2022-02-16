import * as _Tabs from "https://unpkg.com/@triply/yasgui/build/yasgui.min.js";

const examples = [
  {
    name: "List feeds",
    value: `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX ssb: <ssb:ontology:>
PREFIX ssbx: <ssb:ontology:derivatives:>
SELECT * { 
  ?msg ssb:author ?author;
        ssb:seq ?seq. 
} LIMIT 10`,
  },
];

export class QueryElement extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });

    this.shadowRoot.innerHTML = `
    <style>
      .yasgui .autocompleteWrapper {
        display: none !important;
      }
      .yasgui .tabContextButton {
        display: none !important;
      }
      .yasgui .yasqe_share {
        display: none !important;
      }
      #yasgui {

      }
    </style>
    <link href="https://unpkg.com/@triply/yasgui/build/yasgui.min.css" rel="stylesheet" type="text/css" />
    <div id="yasgui"></div>`;
    const yasgui = new Yasgui(this.shadowRoot.getElementById("yasgui"), {
      requestConfig: {
        endpoint: "./query",
        method: "GET",
      },
      copyEndpointOnNewTab: true,
      populateFromUrl: false,
      autofocus: true,
    });
    if (Object.keys(yasgui._tabs).length === 1) {
      const firstTab = yasgui.getTab();
      examples.forEach((example) => {
        const tab = yasgui.addTab(
          true, // set as active tab
          {
            ...Yasgui.Tab.getDefaults(),
            name: example.name,
            requestConfig: {
              endpoint: "./query",
              method: "GET",
            },
          },
        );
        tab.setQuery(example.value);
      });
      yasgui.markTabSelected(firstTab.getId());
    }
  }
}
window.customElements.define("ssb-query", QueryElement);
