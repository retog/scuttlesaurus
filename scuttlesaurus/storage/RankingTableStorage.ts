export default interface RankingTableStorage {
  /** A table indicating how likely a peer has a feed */
  storeFeedPeerRankings(table: Uint8Array[]): Promise<void>;

  getFeedPeerRankings(): Promise<Uint8Array[]>;
}
