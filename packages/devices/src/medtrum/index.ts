/**
 * Medtrum TouchCare Nano driver: a TypeScript port of loopandlearn/MedtrumKit
 * (MIT License, (c) the original MedtrumKit authors).
 */
export { medtrumNanoPump, createMedtrumNanoDriver, MEDTRUM_NANO_SETTINGS, MEDTRUM_NANO_DEFAULTS } from './plugin';
export { MedtrumNanoDriver, MEDTRUM_NANO_META, type MedtrumPatchStatus, type FlowResult, type ExpiryMode } from './driver';
export type { MedtrumNanoSettings, MedtrumDriverOptions } from './driver-core';
export {
  isMedtrumNanoDriver,
  readMedtrumPatchStatus,
  refreshMedtrumPatch,
  primeMedtrumPatch,
  activateMedtrumPatch,
  deactivateMedtrumPatch,
  forceDeactivateMedtrumPatch,
  setMedtrumBasalSchedule,
  updateMedtrumPatchSettings,
  clearMedtrumAlert,
  syncMedtrumPatchTime,
} from './activation';
export { PatchState, patchState, patchStateName } from './enums';
export { MedtrumPatchSimulator, type MedtrumSimulatorOptions } from './simulator';
