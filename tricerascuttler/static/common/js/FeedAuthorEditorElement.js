import { getDescription } from "./FeedAuthorElement.js";
import { iriToSigil, sigilToIri } from "./web-util.js";

export class FeedAuthorEditorElement extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
  }

  async connectedCallback() {
    const feedUri = this.getAttribute("feed");
    this.shadowRoot.innerHTML = `
    <style>
    input, textarea { 
      padding: 9px; 
      border: solid 1px #E5E5E5; 
      outline: 0; 
      font: normal 13px/100% Verdana, Tahoma, sans-serif; 
      width: 200px; 
      background: #FFFFFF; 
      } 
      
    textarea { 
      width: 400px; 
      max-width: 400px; 
      height: 150px; 
      line-height: 150%; 
      } 
      
    input:hover, textarea:hover, 
    input:focus, textarea:focus { 
      border-color: #C9C9C9; 
      } 
      
    .form label { 
      margin-left: 10px; 
      color: #999999; 
      } 
      
    button { 
      width: auto; 
      padding: 9px 15px; 
      background: #617798; 
      border: 0; 
      font-size: 14px; 
      color: #FFFFFF; 
      }
      
      #image {
        min-width: 80px;
        background-color: #8f96a3;
        min-height: 80px;
        border: dotted;
        cursor: pointer;
        transition: 0.5s;
        box-shadow: 0px 5px 15px rgba(0, 0, 0, .2);
      }

      .visually-hidden {
        position: absolute !important;
        height: 1px;
        width: 1px;
        overflow: hidden;
        clip: rect(1px, 1px, 1px, 1px);
      }
      
      /* Separate rule for compatibility, :focus-within is required on modern Firefox and Chrome */
      input.visually-hidden:focus + label {
        outline: thin dotted;
      }
      input.visually-hidden:focus-within + label {
        outline: thin dotted;
      }
    </style>
    <p>
    <form>
    
    <input type="text" id="name">
    <label for="name">Name</label>
    </p>
    <input type="file" id="upload" class="visually-hidden">
    <label for="upload" class="action" >
    <img id="image">
    </label>
    <p>
    <textarea id="description"></textarea>
    <label for="description">Description</label>
    <p class="submit"> 
		<button id="publish">Publish</button>
    <form>
	</p> 
    </p>
    `;
    const nameElt = this.shadowRoot.getElementById("name");
    const descriptionElt = this.shadowRoot.getElementById("description");
    const imageElt = this.shadowRoot.getElementById("image");
    const publishElt = this.shadowRoot.getElementById("publish");
    const { name, description, image } = await getDescription(feedUri);
    nameElt.value = name;
    descriptionElt.value = description;
    if (image) imageElt.src = image.replace("ssb:blob/", "./blob/");
    let replacementImageSigilPromise;
    const uploadElement = this.shadowRoot.getElementById("upload");
    uploadElement.addEventListener("change", handleFiles, false);
    function handleFiles() {
      const file = this.files[0];
      const imageURL = URL.createObjectURL(file);
      imageElt.src = imageURL;
      replacementImageSigilPromise = (async () => {
        const scuttlebuttHost = await window.scuttlebuttHost;
        const bytes = new Uint8Array(await file.arrayBuffer());
        replacementImageSigilPromise = await scuttlebuttHost.blobsStorage
          .storeBlob(bytes);
        await fetch(
          sigilToIri(replacementImageSigilPromise.toString()).replace(
            "ssb:",
            "/",
          ),
        );
      })();
    }
    publishElt.addEventListener("click", async () => {
      const replacementImageSigil = await replacementImageSigilPromise;
      const newImage = replacementImageSigil
        ? replacementImageSigil.toString()
        : (image ? iriToSigil(image) : undefined);
      const content = {
        "type": "about",
        "about": iriToSigil(feedUri),
        image: newImage,
        name: nameElt.value,
        description: descriptionElt.value,
      };
      const scuttlebuttHost = await window.scuttlebuttHost;
      await scuttlebuttHost.publish(content);
      console.log(`content published`, content);
    });
  }
}
window.customElements.define("ssb-feed-author-editor", FeedAuthorEditorElement);
