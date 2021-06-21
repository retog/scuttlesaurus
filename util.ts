export function parseAddress(addr: string) {
  const sections = addr.split(":");
  const [protocol, host, portshs, key] = sections;
  const port = parseInt(portshs.split("~")[0]);
  return { protocol, host, port, key };
}

export function concat(...elems: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    elems.reduce((sum, elem) => sum + (elem.length), 0),
  );
  let pos = 0;
  for (const elem of elems) {
    result.set(elem, pos);
    pos += elem.length;
  }
  return result;
}
