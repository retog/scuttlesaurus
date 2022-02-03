export class HostFolloweesElement extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });

    this.shadowRoot.innerHTML = `<ul id="followeeList">

    </ul>
    Add followee: <input id="newFollowee" type="text" size="90" />
    `;
    const followeeList = this.shadowRoot.getElementById("followeeList");
    const newFollowee = this.shadowRoot.getElementById("newFollowee");

    async function removeFollowee(id) {
      await fetch("./followees", {
        "headers": {
          "Accept": "application/json,*/*;q=0.9",
          "Content-Type": "application/json",
        },
        "body": JSON.stringify({ id, "action": "remove" }),
        "method": "POST",
      });
      populateList();
    }
    async function populateList() {
      const response = await fetch("./followees");
      const followees = await response.json();

      followeeList.replaceChildren();
      followees.forEach((followee) => {
        const li = document.createElement("li");
        li.appendChild(document.createTextNode(followee));
        const button = document.createElement("button");
        li.appendChild(button);
        button.innerHTML = "Remove";
        followeeList.appendChild(li);
        button.addEventListener("click", () => {
          removeFollowee(followee);
        });
      });
    }

    newFollowee.addEventListener("keypress", async (e) => {
      if (e.key === "Enter") {
        await fetch("./followees", {
          "headers": {
            "Accept": "application/json,*/*;q=0.9",
            "Content-Type": "application/json",
          },
          "body": JSON.stringify({ "id": e.target.value }),
          "method": "POST",
        });
        populateList();
        e.target.value = "";
      }
    });
    populateList();
    console.log("all set");
  }
}
window.customElements.define("ssb-host-followees", HostFolloweesElement);
