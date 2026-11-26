/**
 * Omnipod pump drivers: TypeScript port of OmnipodKit (MIT License, (c) LoopKit Authors).
 * `common/` is the shared message layer, `dash/` the DASH Bluetooth driver and `eros-driver/`
 * the Eros driver over a RileyLink. Bench use only: water in the pod, never attached to a body.
 */
export * from './dash';
export { omnipodErosPump, createOmnipodErosDriver, OmnipodErosDriver, ErosPodBench, isOmnipodErosDriver, readErosPodStatus, refreshErosPod, pairAndPrimeErosPod, insertErosCannula, deactivateErosPod, discardErosPod, scanForRileyLinks, type OmnipodErosSettings, type RileyLinkAdvertisement } from './eros-driver';
