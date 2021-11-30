'use strict';
//https://github.com/mdn/web-components-examples/blob/master/editable-list/main.js
(function() {
  class EditableList extends HTMLElement {
    constructor() {
      // establish prototype chain
      super();

      // attaches shadow tree and returns shadow root reference
      // https://developer.mozilla.org/en-US/docs/Web/API/Element/attachShadow
      const shadow = this.attachShadow({ mode: 'open' });

      // creating a container for the editable-list component
      const editableListContainer = document.createElement('div');

      // get attribute values from getters
      const title = this.title;
      const addItemText = this.addItemText;
      this.items = [];

      // adding a class to our container for the sake of clarity
      editableListContainer.classList.add('editable-list');

      // creating the inner HTML of the editable list element
      editableListContainer.innerHTML = `
        <style>
          li, div > div {
            display: flex;
            align-items: center;
            justify-content: space-between;
          }

          .icon {
            background-color: #fff;
            border: none;
            cursor: pointer;
            float: right;
            font-size: 1.8rem;
          }
        </style>
        <h3>${title}</h3>
        <ul class="item-list">
          ${this.items.map(this.createListItem).join('')}
        </ul>
        <div>
          <label>${addItemText}</label>
          <input class="add-new-list-item-input" type="text"></input>
          <button class="editable-list-add-item icon">&oplus;</button>
        </div>
      `;

      // binding methods
      this.addListItem = this.addListItem.bind(this);
      this.handleRemoveItemListeners = this.handleRemoveItemListeners.bind(this);
      this.removeListItem = this.removeListItem.bind(this);

      // appending the container to the shadow DOM
      shadow.appendChild(editableListContainer);
    }

    createListItem(value) {
      return  `
      <li><span class="value">${value}</span>
        <button class="editable-list-remove-item icon">&ominus;</button>
      </li>
    `
    }
    // add items to the list
    addListItem(e) {
      const textInput = this.shadowRoot.querySelector('.add-new-list-item-input');

      if (textInput.value) {
        this.addValue(textInput.value);
        textInput.value = '';
        this.dispatchEvent(new CustomEvent("change"));
      }
    }

    addValue(value) {
      this.itemList.innerHTML += this.createListItem(value);
      this.handleRemoveItemListeners([...this.shadowRoot.querySelectorAll('.editable-list-remove-item')]);
    }

    // fires after the element has been attached to the DOM
    connectedCallback() {
      const removeElementButtons = [...this.shadowRoot.querySelectorAll('.editable-list-remove-item')];
      const addElementButton = this.shadowRoot.querySelector('.editable-list-add-item');

      this.itemList = this.shadowRoot.querySelector('.item-list');

      this.handleRemoveItemListeners(removeElementButtons);
      addElementButton.addEventListener('click', this.addListItem, false);
    }

    // gathering data from element attributes
    get title() {
      return this.getAttribute('title') || '';
    }


    get addItemText() {
      return this.getAttribute('add-item-text') || '';
    }

    get values() {
      return [...this.shadowRoot.querySelectorAll('.value')].map(e => e.textContent)
    }

    handleRemoveItemListeners(arrayOfElements) {
      arrayOfElements.forEach(element => {
        element.addEventListener('click', this.removeListItem, false);
      });
    }

    removeListItem(e) {
      e.target.parentNode.remove();
      this.dispatchEvent(new CustomEvent("change"));
    }
  }

  // let the browser know about the custom element
  customElements.define('editable-list', EditableList);
})();
