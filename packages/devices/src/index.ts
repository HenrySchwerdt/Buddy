import { createRegistry, type CgmPlugin, type PumpPlugin, type Registry } from '@buddy/core';
import { demoCgm, demoPump } from './demo/plugins';
import { dexcomShareCgm } from './dexcom-share';
import { dexcomG6Cgm } from './dexcom-g6';
import { dexcomG7Cgm } from './dexcom-g7';
import { libre2DirectCgm, libreTransmitterCgm } from './libre';
import { libreLinkUpCgm } from './libre-link-up';
import { medtrumNanoPump } from './medtrum';
import { danaPump } from './dana';
import { nightscoutCgm } from './nightscout';
import { nightscoutFollower } from './nightscout/follower';

export { demoCgm, demoPump, dexcomShareCgm, nightscoutCgm, nightscoutFollower, dexcomG6Cgm, dexcomG7Cgm };
export { createDexcomG6Source, parseGlucoseRx, computeHash } from './dexcom-g6';
export { danaPump, DanaPumpDriver, DanaPumpSimulator, DANA_META, type DanaSettings } from './dana';
export { medtrumNanoPump, createMedtrumNanoDriver, MedtrumNanoDriver, MedtrumPatchSimulator, isMedtrumNanoDriver, readMedtrumPatchStatus, refreshMedtrumPatch, primeMedtrumPatch, activateMedtrumPatch, deactivateMedtrumPatch, forceDeactivateMedtrumPatch, setMedtrumBasalSchedule, updateMedtrumPatchSettings, clearMedtrumAlert, syncMedtrumPatchTime, type MedtrumNanoSettings, type MedtrumPatchStatus } from './medtrum';
export { libre2DirectCgm, libreTransmitterCgm, pairSensor, PairingError, LIBRE_SECRET_KEYS, type SensorPairingInfo, type LibreCgmSource } from './libre';
export { libreLinkUpCgm, libreLinkUpHost, parseLibreLinkUpGraph, parseLibreLinkUpTimestamp, trendFromLibreArrow, LIBRE_LINK_UP_ID, LIBRE_LINK_UP_MIN_INTERVAL_MS, type LibreLinkUpSettings } from './libre-link-up';
export { createDexcomG7Source, parseG7GlucoseMessage, parseG7BackfillMessage } from './dexcom-g7';
export { parseTreatmentsToDoses, parseTreatmentsToCarbs, parseDeviceStatus, parseNightscoutProfile } from './nightscout/follower';
export * from './testkit';
export { demoHub, createDemoHub, type DemoHub } from './demo/hub';
export { parseNightscoutEntries, normalizeBaseUrl } from './nightscout';
export { parseShareReadings, parseShareDate } from './dexcom-share';
export { trendFromDirection } from './trend';

/** Pump drivers bundled with Buddy. Real pumps arrive as native-module plugins (docs/ADDING_A_DEVICE.md). */
export const BUILT_IN_PUMPS: readonly PumpPlugin[] = [demoPump, nightscoutFollower, danaPump, medtrumNanoPump] as unknown as PumpPlugin[];
export const BUILT_IN_CGMS: readonly CgmPlugin[] = [demoCgm, dexcomG7Cgm, dexcomG6Cgm, libre2DirectCgm, libreTransmitterCgm, libreLinkUpCgm, nightscoutCgm, dexcomShareCgm] as unknown as CgmPlugin[];

export const createPumpRegistry = (): Registry<PumpPlugin> => createRegistry(BUILT_IN_PUMPS);
export const createCgmRegistry = (): Registry<CgmPlugin> => createRegistry(BUILT_IN_CGMS);
