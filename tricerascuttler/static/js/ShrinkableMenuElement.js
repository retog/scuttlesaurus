/** web component `ssb-shrinkable-menu` provides a horizontal list of buttons
 * that expands to a vertical menu alligne to the right if not enough
 * horizontal space is available or when buttons have the atrribute `extra`.
 */
export class ShrinkableMenuElement extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
  }

  connectedCallback() {
    //const contentArea = document.createElement("div");
    const menuArea = document.createElement("div");
    menuArea.className = "menu";
    const extraArea = document.createElement("div");
    extraArea.className = "extra";
    const buttons = [...this.querySelectorAll("button")];
    const menuButtonHolders = buttons.map((button) => ({
      button,
      isExtra: button.hasAttribute("extra"),
    }));
    const styleElement = document.createElement("style");
    styleElement.textContent = `
    .menu {
      background-color: #bccbe9;
    }

    :host {
      width: 100%;
      margin: auto;
      position:relative;
      display: grid;
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
    }

    .showextra div.extra {
      display:grid;
      position: absolute;
      right: 0;
      z-index: 1;
    }

    div.main:not(.showextra) div.extra {
      display: none;
    }
    
    div.main {
      width:100%;
      height: auto;
      overflow: hidden;
    }

    button:hover {
      background-color: #d5e3ff;
    }
    
    button.active {
      background-color: white;
    }

    `;
    const mainArea = document.createElement("div");
    mainArea.className = "main";
    const extraButton = document.createElement("button");
    extraButton.innerHTML = ">>";
    extraButton.className = "extra";
    extraButton.addEventListener("click", () => {
      mainArea.classList.toggle("showextra");
    });
    buttons.forEach((button) =>
      button.addEventListener("click", () => {
        mainArea.classList.remove("showextra");
      })
    );
    const fillMenus = () => {
      menuButtonHolders.forEach((holder) => {
        (holder.isExtra ? extraArea : menuArea).append(holder.button);
      });
      menuArea.append(extraButton);
      //menuArea.append(terminusButton)
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
    this.shadowRoot.append(styleElement);
    this.shadowRoot.append(menuArea);
    mainArea.append(extraArea);
    //mainArea.append(contentArea);
    this.shadowRoot.append(mainArea);
    const observer = new ResizeObserver(() => {
      //menuArea.replaceChildren();
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
window.customElements.define("ssb-shrinkable-menu", ShrinkableMenuElement);
