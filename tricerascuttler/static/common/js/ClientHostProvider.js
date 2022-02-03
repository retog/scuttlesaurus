import ScuttlebuttHost, {
  FeedId,
  parseAddress,
  parseFeedId,
} from "./ext/scuttlebutt-host.js";
export default class ClientHostProvider {
  async getScuttlebuttHost() {
    const host = new ScuttlebuttHost({});
    const keyPair = host.getClientKeyPair();
    await console.log(new FeedId(keyPair.publicKey).toString());
    return host;
  }
}
