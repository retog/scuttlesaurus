if (Deno.args.length !== 1) {
  throw new Error("expecting  one argument");
}

const fileName = Deno.args[0];

const peers =
  (JSON.parse(Deno.readTextFileSync(fileName)) as { address: string }[]).map(
    (peer) => peer.address,
  );

console.log(JSON.stringify(peers));
