/**
 * Omnipod Eros driver: a TypeScript port of the Eros parts of OmnipodKit (MIT License,
 * (c) LoopKit Authors). The pod is reached through a RileyLink.
 */
export { omnipodErosPump, createOmnipodErosDriver, OMNIPOD_EROS_SETTINGS, OMNIPOD_EROS_DEFAULTS } from './plugin';
export { OmnipodErosDriver, OMNIPOD_EROS_META } from './driver';
export type { OmnipodErosSettings, ErosDriverOptions } from './driver-core';
export type { FlowResult, OmnipodPodStatus, PodPhase } from '../dash/driver-setup';
export {
  isOmnipodErosDriver,
  readErosPodStatus,
  refreshErosPod,
  pairAndPrimeErosPod,
  insertErosCannula,
  deactivateErosPod,
  discardErosPod,
} from './activation';
export { scanForRileyLinks, type RileyLinkAdvertisement } from './scan';
export { ErosPodBench, type ErosPodBenchOptions } from './simulator';
