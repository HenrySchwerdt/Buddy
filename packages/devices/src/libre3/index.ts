/**
 * FreeStyle Libre 3 / 3+ direct CGM driver: TypeScript port of the protocol logic of RoundWhiteDiscKit
 * (NFC activation, pairing, BLE transport, authorization, data-plane decoding) and of the CGM-manager
 * behaviour of LibreLoop (reconnect with the persisted receiver id, 5-minute readings, backfill,
 * sensor lifetime). Both MIT, (c) their authors.
 *
 * Independent of Abbott and not endorsed by Abbott. Experimental; not a medical device.
 * The app credential (P-256 key + 162-byte certificate) is NOT included: supply it with
 * `installAppIdentities` or the plugin's `appCredential` setting.
 */
export { libre3DirectCgm, createLibre3Source, LIBRE3_META, type Libre3CgmSource, type Libre3DirectSettings, type Libre3SourceOptions, type Libre3Status } from './plugin';
export { pairLibre3Sensor, Libre3PairingError, LIBRE3_PAIRING_ALERT, type Libre3PairingErrorCode, type Libre3PairingInfo, type PairLibre3Options } from './pairing';
export { installAppIdentities, loadAppIdentities, parseAppIdentities, createAppIdentity, AppIdentityError, type AppIdentity } from './identity';
export { LIBRE3_SECRET_KEYS, loadSensorState, type Libre3SensorState } from './storage';
export { receiverIdFromAccount, accountlessReceiverId, parseReceiverIdHex, receiverIdToHex, type ReceiverIdDerivation } from './nfc';
export { LIBRE3_ID } from './constants';
export { DEFAULT_TIMING, type Libre3Timing } from './timing';
