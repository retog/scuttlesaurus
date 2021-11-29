import CommClientInterface from "./CommClientInterface.ts";
import CommServerInterface from "./CommServerInterface.ts";

/** An object that allows to receive and initiate connections of a certain type */
export default interface CommInterface<T>
  extends CommServerInterface<T>, CommClientInterface<T> {
}
