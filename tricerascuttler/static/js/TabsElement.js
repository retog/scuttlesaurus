export class TabsElement extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    const tabs = [...this.querySelectorAll("ssb-tab")];
    const contentArea = document.createElement("div");
    const menuArea = document.createElement("div");
    menuArea.className = "menu";
    const wrapperArea = document.createElement("div");
    wrapperArea.className = "wrapper"; // :host
    const styleElement = document.createElement("style");
    styleElement.textContent = `

    
    .menu {
      display: grid;
      grid-template-columns: ${tabs.map(() => "1fr").join(" ")};
    }

    .wrapper {
      width: 100%;
      margin: auto;
      background-color: white;
      border-radius: 10px;
      box-shadow: 0px 5px 15px rgba(0, 0, 0, .1);
    }
    
    button {
      letter-spacing: 3px;
      border: none;
      padding: 10px;
      background-color: #bccbe9;
      color: #232c3d;
      font-size: 18px;
      cursor: pointer;
      transition: 0.5s;
    }
    
    button:hover {
      background-color: #d5e3ff;
    }
    
    button.active {
      background-color: white;
    }
    
    .active {
      background-color: white;
    }

    `;
    const menuButtons = tabs.map((tab) => {
      const button = document.createElement("button");
      button.innerHTML = tab.getAttribute("label");
      const templateId = tab.getAttribute("template");
      const children = [...tab.childNodes].map((child) =>
        child.cloneNode(true)
      );
      button.onclick = () => {
        if (templateId) {
          const template = document.getElementById(templateId);
          contentArea.replaceChildren(template.content.cloneNode(true));
        } else {
          if (tab.children[0].tagName === "TEMPLATE") {
            contentArea.replaceChildren(
              tab.children[0].content.cloneNode(true),
            );
          } else {
            contentArea.replaceChildren(...children);
          }
        }
        this.shadowRoot.querySelectorAll("button").forEach((btn) => {
          btn.classList.remove("active");
        });
        button.classList.add("active");
      };
      if (tab.hasAttribute("active")) {
        button.click();
      }
      return button;
    });
    menuButtons.forEach((button) => menuArea.append(button));
    menuButtons[0].style = "border-top-left-radius: 10px;";
    menuButtons[menuButtons.length - 1].style =
      "border-top-right-radius: 10px;";
    this.shadowRoot.append(styleElement);
    wrapperArea.append(menuArea);
    wrapperArea.append(contentArea);
    this.shadowRoot.append(wrapperArea);
  }
}
window.customElements.define("ssb-tabs", TabsElement);
