export const QUEUE_ASSET_PROCESSING = 'asset-processing';

export interface AssetProcessingJob {
  assetId: string;
  processor: string;
}
