import { Address } from "../util.ts";

/** An object that allows to receive and initiate connections of a certain type */
export default interface CommInterface<T> {
  connect(addr: Address): Promise<T>;
  listen(): AsyncIterable<T>;
}
