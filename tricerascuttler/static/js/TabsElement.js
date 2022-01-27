import * as _Menu from "./ShrinkableMenuElement.js";

export class TabsElement extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    const tabs = [...this.querySelectorAll("ssb-tab")];
    const contentArea = document.createElement("div");
    const shrinkMenuButtons = [];
    const rightFixedButtons = [];
    tabs.map((tab) => {
      const button = document.createElement("button");
      button.classList.add("tabButton");
      button.innerHTML = tab.getAttribute("label");
      const templateId = tab.getAttribute("template");
      const href = tab.getAttribute("href");
      if (tab.hasAttribute("extra")) {
        button.setAttribute("extra", true);
      }
      const children = [...tab.childNodes].map((child) =>
        child.cloneNode(true)
      );
      button.addEventListener("click", () => {
        if (href) {
          window.location.assign(href);
        } else {
          const scrollPosition = [window.scrollX, window.scrollY];
          if (templateId) {
            const template = document.getElementById(templateId);
            contentArea.replaceChildren(template.content.cloneNode(true));
          } else if (
            tab.children.length > 0 && tab.children[0].tagName === "TEMPLATE"
          ) {
            contentArea.replaceChildren(
              tab.children[0].content.cloneNode(true),
            );
          } else {
            contentArea.replaceChildren(...children);
          }
          /* a better solution might to first make the old content invisible and remove
          only when new content had some time to expand */
          //70ms is enough sometimes
          setTimeout(() => window.scrollTo(...scrollPosition), 70);
          setTimeout(() => window.scrollTo(...scrollPosition), 400);
        }
      });
      if (tab.hasAttribute("active")) {
        if (!href) {
          setTimeout(() => button.click(), 200);
        } else {
          button.classList.add("active");
        }
      }
      if (href === document.location.pathname) {
        button.classList.add("active");
      }
      if (tab.hasAttribute("right-fixed")) {
        rightFixedButtons.push(button);
      } else {
        shrinkMenuButtons.push(button);
      }
    });
    const menuBar = document.createElement("div");
    menuBar.className = "menu";
    const shrinkMenu = document.createElement("ssb-shrinkable-menu");
    const rightFixedMenu = document.createElement("div");
    menuBar.append(shrinkMenu);
    menuBar.append(rightFixedMenu);
    const allButtons = [...shrinkMenuButtons, ...rightFixedButtons];
    allButtons.forEach((button) => {
      button.addEventListener("click", () => {
        allButtons.forEach((btn) => {
          btn.classList.remove("active");
        });
        button.classList.add("active");
      });
    });
    shrinkMenuButtons.forEach((button) => {
      shrinkMenu.append(button);
    });
    rightFixedButtons.forEach((button) => {
      rightFixedMenu.append(button);
    });

    const wrapperArea = document.createElement("div");
    wrapperArea.className = "wrapper"; // :host
    const styleElement = document.createElement("style");
    styleElement.textContent = `
    .menu {
      background-color: #bccbe9;
      display:grid;
      grid-template-columns: auto min-content;
    }

    :host {
      width: 100%;
      margin: auto;
      position:relative;
    }

    .tabButton {
      letter-spacing: 3px;
      border: none;
      padding: 10px;
      background-color: #bccbe9;
      color: #232c3d;
      font-size: 18px;
      cursor: pointer;
      transition: 0.5s;
      box-shadow: 0px 5px 15px rgba(0, 0, 0, .2);
    }

    button:hover {
      background-color: #d5e3ff;
    }
    
    .tabButton.active {
      background-color: white;
    }

    `;
    this.shadowRoot.append(styleElement);
    this.shadowRoot.append(menuBar);
    this.shadowRoot.append(contentArea);
  }
}
window.customElements.define("ssb-tabs", TabsElement);
