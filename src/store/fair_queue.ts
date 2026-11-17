/**
 * A queue that serves its keys (clients) in turn: the next item comes from the
 * key that was served longest ago, not from whoever queued first. A client
 * that queues eight items waits behind one item of every other client, not
 * the other way round, and a client whose query has just run goes behind
 * those that have not been served yet.
 *
 * @module
 */
export class FairQueue<T> {
  readonly #lists = new Map<string, T[]>();
  /** When each key was last served (a counter); never served is absent. */
  readonly #served = new Map<string, number>();
  #turn = 0;
  #length = 0;

  get length(): number {
    return this.#length;
  }

  push(key: string, item: T): void {
    const list = this.#lists.get(key);
    if (list) list.push(item);
    else this.#lists.set(key, [item]);
    this.#length++;
  }

  /**
   * The next item in turn: the first of the key that was served longest ago
   * (a key never served goes before all others; ties go to the key that
   * queued first). Undefined when empty.
   */
  shift(): T | undefined {
    let chosen: string | undefined;
    let best = Infinity;
    for (const key of this.#lists.keys()) {
      const at = this.#served.get(key) ?? -1;
      if (at < best) {
        best = at;
        chosen = key;
      }
    }
    if (chosen === undefined) return undefined;
    const list = this.#lists.get(chosen)!;
    const item = list.shift()!;
    if (list.length === 0) this.#lists.delete(chosen);
    this.#served.set(chosen, this.#turn++);
    this.#length--;
    // Remember only what can matter: keys that were served recently.
    if (this.#served.size > 1024) {
      for (const key of this.#served.keys()) {
        if (!this.#lists.has(key)) this.#served.delete(key);
        if (this.#served.size <= 512) break;
      }
    }
    return item;
  }

  /** Remove an item that is still queued; false when it is not. */
  remove(item: T): boolean {
    for (const [key, list] of this.#lists) {
      const index = list.indexOf(item);
      if (index < 0) continue;
      list.splice(index, 1);
      if (list.length === 0) this.#lists.delete(key);
      this.#length--;
      return true;
    }
    return false;
  }

  /** Take everything out, in the order it would have been served. */
  drain(): T[] {
    const items: T[] = [];
    for (let item = this.shift(); item !== undefined; item = this.shift()) {
      items.push(item);
    }
    return items;
  }
}
