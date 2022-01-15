import { handleSsbLinks, iriToSigil, mdToHtml, runQuery } from "./web-util.js";

const syncIcon = `
  <?xml version="1.0" encoding="iso-8859-1"?>
<svg version="1.1" id="Layer_1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" x="0px" y="0px"
	 viewBox="0 0 512 512" style="enable-background:new 0 0 512 512;" xml:space="preserve">
<g>
	<g>
		<g>
			<path d="M341.325,245.332c-11.797,0-21.333,9.536-21.333,21.333v21.461c-18.219-13.653-40.619-21.461-64-21.461
				c-58.816,0-106.667,47.851-106.667,106.667c0,58.816,47.851,106.667,106.667,106.667c18.731,0,37.184-4.928,53.333-14.272
				c10.219-5.888,13.717-18.965,7.808-29.141c-5.909-10.24-18.965-13.739-29.141-7.808c-9.685,5.589-20.757,8.555-32,8.555
				c-35.285,0-64-28.715-64-64s28.715-64,64-64c18.219,0,35.221,8.085,47.232,21.333h-25.899c-11.797,0-21.333,9.536-21.333,21.333
				s9.536,21.333,21.333,21.333h64c11.797,0,21.333-9.536,21.333-21.333v-85.333C362.658,254.868,353.122,245.332,341.325,245.332z"
				/>
			<path d="M446.784,186.113c-9.749-73.387-76.949-154.112-157.76-154.112c-43.328,0-87.381,21.291-116.8,55.445
				c-9.408-3.435-19.371-5.205-29.525-5.205c-45.973,0-83.648,36.224-85.952,81.643C22.784,185.772,0,226.198,0,266.668
				c0,25.344,8.405,53.461,23.061,77.12c18.091,29.227,50.261,47.936,85.227,50.389c-0.96-6.827-1.621-13.76-1.621-20.843
				c0-82.325,66.987-149.333,149.333-149.333c11.541,0,23.083,1.387,34.304,4.075c11.691-15.424,30.208-25.408,51.029-25.408
				c35.285,0,64,28.715,64,64v85.333c0,16.427-6.357,31.317-16.555,42.667h13.675c55.36,0,103.168-41.216,108.843-93.845
				c0.469-4.203,0.704-8.491,0.704-12.821C512,239.02,486.912,200.684,446.784,186.113z"/>
		</g>
	</g>
</g>
<g>
</g>
<g>
</g>
<g>
</g>
<g>
</g>
<g>
</g>
<g>
</g>
<g>
</g>
<g>
</g>
<g>
</g>
<g>
</g>
<g>
</g>
<g>
</g>
<g>
</g>
<g>
</g>
<g>
</g>
</svg>`;

async function getDescription(feedUri) {
  const query = `PREFIX ssb: <ssb:ontology:>

  SELECT ?name ?description ?image {
    ?about ssb:content ?aboutContent.
    ?about ssb:timestamp ?timestamp.
    ?aboutContent ssb:about <${feedUri}>.
    OPTIONAL {  ?aboutContent ssb:name ?name }
    OPTIONAL {  ?aboutContent ssb:description ?description }
    OPTIONAL {  ?aboutContent ssb:image ?image }
  } ORDER BY ASC(?timestamp)`;

  const resultJson = await runQuery(query);
  let name = undefined;
  let description, image;
  for (const binding of resultJson.results.bindings) {
    if (binding.name?.value) {
      name = binding.name?.value;
    }
    if (binding.description?.value) {
      description = binding.description?.value;
    }
    if (binding.image?.value) {
      image = binding.image?.value;
    }
  }
  return { name, description, image };
}

export class FeedAuthorElement extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    const feedUri = this.getAttribute("src");
    const mode = this.getAttribute("mode");
    getDescription(feedUri).then(
      ({ name, description, image }) => {
        const renderedDescription = description
          ? mode === "small"
            ? description.substring(0, 80)
            : mdToHtml(description) +
              "<br/>"
          : "";

        const template = `
      <style>
        :host {
          display: flex;
          flex-direction: column;
          justify-content: center;
          align-items: center;
          background-color: lavenderblush;
        }
    
        div {
          border-style: solid;
          margin: 5pt;
          padding: 5pt;
        }
        ${
          mode === "small"
            ? `img {
            max-width: 40px;
            max-height: 40px;
          }`
            : `img {
              max-width: 100%;
            }`
        }
      </style>
    
      <div>
      <a href="/?uri=${feedUri}">${
          name ? name : feedUri.substring(0, 23) + "..."
        }</a>
      <svg id="sync" width="20pt" height="20pt">${syncIcon}</svg><br/>
      ${renderedDescription}
      ${image ? `<img src="${image.replace("ssb:blob/", "./blob/")}">` : ""}
      </div>
      <slot></slot>
    `;
        this.shadowRoot.innerHTML = template;
        const syncButton = this.shadowRoot.getElementById("sync");
        syncButton.addEventListener("click", async () => {
          await fetch("./followees", {
            "headers": {
              "Accept": "application/json,*/*;q=0.9",
              "Content-Type": "application/json",
            },
            "body": JSON.stringify({ "id": iriToSigil(feedUri) }),
            "method": "POST",
          });
          syncButton.parentNode.removeChild(syncButton);
        });
        handleSsbLinks(this.shadowRoot);
      },
    );
  }
}
window.customElements.define("ssb-feed-author", FeedAuthorElement);
