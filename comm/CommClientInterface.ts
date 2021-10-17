import { Address } from "../util.ts";

/** An object that allows to initiate connections of a certain type */
export default interface CommClientInterface<T> {
  /** returns a promise that resolves to a conncection to the specifified address.
   * If the address cannot be contacted by this interface, the promise is rejected. */
  connect(addr: Address): Promise<T>;
}
