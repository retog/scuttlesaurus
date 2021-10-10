/** An object that allows to receive and connections of a certain type */
export default interface CommServerInterface<T> {
  listen(): AsyncIterable<T>;
}
