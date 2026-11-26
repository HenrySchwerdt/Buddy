/**
 * Accu-Chek Insight pump driver: a TypeScript port of InsightKit (Buddy owner's Swift driver for
 * the Insight through an InsightBridge Android app). Register `accuChekInsightPump` in the pump
 * registry; `pairInsightBridge` / `scanInsightBridges` are used by the setup screen.
 */
export { accuChekInsightPump, createInsightDriver, INSIGHT_DEFAULTS, INSIGHT_SETTINGS } from './plugin';
export { InsightPumpDriver, INSIGHT_META, isInsightDriver, type InsightPumpInfo, type PendingCommandInfo } from './driver';
export type { InsightDriverOptions, InsightSettings, ResolveOutcome } from './driver-core';
export { pairInsightBridge, scanInsightBridges, bridgeDisplayName, type DiscoveredBridge, type InsightPairing, type PairingEvent, type PairingOptions, type PairingResult, type ScanOptions } from './pairing';
export { InsightBridgeSimulator, type InsightSimOptions } from './simulator';
export { BridgeError, type BridgeErrorKind, type BridgeStatus } from './models';
export { parseBasalProfile, tryParseBasalProfile, simplifyBasalSchedule, INSIGHT_SPEC, type SimplifiedProfile } from './dosing-math';
export { DEFAULT_TIMEOUTS as INSIGHT_DEFAULT_TIMEOUTS, BRIDGE_SERVICE_UUID, type InsightTimeouts } from './constants';
export { decodeCredentials, encodeCredentials, loadCredentials, saveCredentials, deleteCredentials, credentialsKey, type InsightCredentials } from './credentials';
