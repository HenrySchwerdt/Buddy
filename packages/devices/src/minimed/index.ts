/**
 * Medtronic MiniMed pump driver: a TypeScript port of MinimedKit (migrated from ps2/rileylink_ios,
 * MIT License, (c) LoopKit Authors). The pump is reached through a RileyLink. Experimental: it has
 * never run on real hardware.
 *
 * RileyLink discovery for the setup is `scanForRileyLinks` of the Omnipod Eros driver (the same
 * bridge), so it is not exported a second time here.
 */
export { minimedPump, createMinimedDriver, MINIMED_SETTINGS, MINIMED_DEFAULTS } from './plugin';
export { MinimedDriver, MINIMED_META, type MinimedPumpStatus } from './driver';
export type { MinimedSettings, MinimedDriverOptions } from './driver-core';
export { isMinimedDriver, readMinimedStatus, refreshMinimed, tuneMinimedRadio } from './activation';
export { MinimedPumpBench, MinimedPumpSimulator, type MinimedPumpBenchOptions, type MinimedPumpSimulatorOptions } from './simulator';
export { PUMP_MODELS as MINIMED_PUMP_MODELS, type PumpModel as MinimedPumpModel, type PumpRegion as MinimedPumpRegion } from './models';
