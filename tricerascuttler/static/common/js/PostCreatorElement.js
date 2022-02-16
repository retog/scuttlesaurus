export class PostCreatorElement extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
  }

  connectedCallback() {
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
      max-width: 90%; 
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

    button:disabled {
      background: lightgrey;
    }
     
    </style>
    <textarea id="text"></textarea>
    <button id="publish">Publish</button>
    `;
    const textElt = this.shadowRoot.getElementById("text");
    const publishElt = this.shadowRoot.getElementById("publish");
    publishElt.disabled = true;
    [textElt].forEach((elt) =>
      elt.addEventListener("keypress", () => {
        publishElt.disabled = false;
      })
    );

    publishElt.addEventListener("click", async () => {
      const text = textElt.value;
      const content = {
        type: "post",
        text,
      };
      const scuttlebuttHost = await window.scuttlebuttHost;
      await scuttlebuttHost.publish(content);
      console.log(`content published`, content);
      publishElt.disabled = true;
      textElt.value = "";
    });
  }
}
window.customElements.define("ssb-post-creator", PostCreatorElement);
