export interface IndexerSearchResult {
  indexerId: string;
  indexerName: string;
  title: string;
  /** Magnet URI if the indexer provided one; a torrent-file download URL otherwise. */
  link: string;
  hasMagnet: boolean;
  sizeBytes: number;
  seeders: number;
  peers: number;
  publishedAt: string | null;
}

export interface IndexerConfigInput {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
}
