import type { SchedulePack } from '@tierwyn/shared';
import { singlePrFeaturePack } from './single-pr-feature.js';
import { phasedFeaturePack } from './phased-feature.js';
import { featureWavePack } from './feature-wave.js';
import { fixFromFailurePack } from './fix-from-failure.js';
import { prReviewPack } from './pr-review.js';
import { verifyAfterChangePack } from './verify-after-change.js';
import { docsCampaignPack } from './docs-campaign.js';

export const SHIPPED_PACKS: SchedulePack[] = [
  singlePrFeaturePack,
  phasedFeaturePack,
  featureWavePack,
  fixFromFailurePack,
  prReviewPack,
  verifyAfterChangePack,
  docsCampaignPack,
];

export {
  singlePrFeaturePack,
  phasedFeaturePack,
  featureWavePack,
  fixFromFailurePack,
  prReviewPack,
  verifyAfterChangePack,
  docsCampaignPack,
};
