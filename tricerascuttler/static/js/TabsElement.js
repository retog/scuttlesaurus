export class TabsElement extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    const plainmenu = this.hasAttribute("plainmenu");
    const tabs = [...this.querySelectorAll("ssb-tab")];
    const contentArea = document.createElement("div");
    const menuArea = document.createElement("div");
    menuArea.className = "menu";
    const extraArea = document.createElement("div");
    extraArea.className = "extra";
    const wrapperArea = document.createElement("div");
    wrapperArea.className = "wrapper"; // :host
    const styleElement = document.createElement("style");
    styleElement.textContent = `
    .menu {
      background-color: #bccbe9;
      ${
      plainmenu ? "" : `
      border-top-left-radius: 10px;
      border-top-right-radius: 10px;
      `
    }
    }

    .wrapper {
      width: 100%;
      margin: auto;
      ${
      plainmenu ? "" : `background-color: white;
      border-radius: 10px;
      box-shadow: 0px 5px 15px rgba(0, 0, 0, .1);
      `
    }
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
      box-shadow: 0px 5px 15px rgba(0, 0, 0, .2);
    }

    button.extra {
      float: right;
      border-top-right-radius: 10px;
    }

    .showextra div.extra {
      float: right;
      display:grid;
    }

    div.main:not(.showextra) div.extra {
      display: none;
    }
    
    div.main {
      width:100%;
      height: auto;
      overflow: hidden;
      ${plainmenu ? "" : `padding-bottom:5px;`}
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
    const menuButtonHolders = tabs.map((tab) => {
      const button = document.createElement("button");
      button.innerHTML = tab.getAttribute("label");
      const templateId = tab.getAttribute("template");
      const href = tab.getAttribute("href");
      const isExtra = tab.hasAttribute("extra");
      const children = [...tab.childNodes].map((child) =>
        child.cloneNode(true)
      );
      button.onclick = () => {
        if (href) {
          window.location.assign(href);
        } else {
          const scrollPosition = [window.scrollX, window.scrollY];
          console.log(scrollPosition);
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
          mainArea.classList.remove("showextra");
          /* a better solution might to first make the old content invisible and remove
          only when new content had some time to expand */
          //70ms is enough sometimes
          setTimeout(() => window.scrollTo(...scrollPosition), 70);
          setTimeout(() => window.scrollTo(...scrollPosition), 400);
        }
        this.shadowRoot.querySelectorAll("button").forEach((btn) => {
          btn.classList.remove("active");
        });
        button.classList.add("active");
      };
      if (tab.hasAttribute("active")) {
        if (!href) {
          button.click();
        } else {
          button.classList.add("active");
        }
      }
      if (href === document.location.pathname) {
        button.classList.add("active");
      }
      return { button, isExtra };
    });
    const extraButton = document.createElement("button");
    extraButton.innerHTML = ">>";
    extraButton.className = "extra";
    extraButton.onclick = () => {
      mainArea.classList.toggle("showextra");
    };
    const fillMenus = () => {
      menuButtonHolders.forEach((holder) => {
        (holder.isExtra ? extraArea : menuArea).append(holder.button);
      });
      menuArea.append(extraButton);
    };
    fillMenus();
    const extraButtonVisibility = () => {
      if (extraArea.querySelectorAll("button").length === 0) {
        extraButton.style = `display: none`;
      } else {
        extraButton.style = `display: block`;
      }
    };
    extraButtonVisibility();
    if (!plainmenu) {
      menuButtonHolders[0].button.style = "border-top-left-radius: 10px;";
    }
    this.shadowRoot.append(styleElement);
    wrapperArea.append(menuArea);
    const mainArea = document.createElement("div");
    mainArea.className = "main";
    mainArea.append(extraArea);
    mainArea.append(contentArea);
    wrapperArea.append(mainArea);
    this.shadowRoot.append(wrapperArea);
    const observer = new ResizeObserver(() => {
      menuArea.replaceChildren();
      extraArea.replaceChildren();
      fillMenus();
      while (
        [...menuArea.querySelectorAll("button")].reduce(
              (total, button) => total + button.offsetWidth,
              0,
            ) + 0.3 * extraButton.offsetWidth > menuArea.offsetWidth
      ) {
        const menuButtons = [...menuArea.querySelectorAll("button")];
        if (menuButtons.length < 2) break;
        const lastButton = menuButtons[menuButtons.length - 2];
        menuArea.removeChild(lastButton);
        extraArea.insertBefore(lastButton, extraArea.firstChild);
      }
      extraButtonVisibility();
    });
    observer.observe(menuArea);
  }
}
window.customElements.define("ssb-tabs", TabsElement);
