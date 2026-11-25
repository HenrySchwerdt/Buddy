/**
 * Freestyle Libre CGM drivers: TypeScript port of loopandlearn/LibreTransmitter
 * (MIT, (c) Uwe Petersen, Reimar Metzen, the LoopKit and LibreTransmitter authors).
 *
 * Supported: Libre 2 (EU) direct BLE after NFC pairing, and Libre 1 / Libre 2 (EU) / Libre US
 * 14-day FRAM via MiaoMiao or Bubble transmitters. Not supported (absent from the Swift package):
 * Libre 3, Libre 2 US/CA BLE, Libre 2+ / Libre Sense streaming, sensor activation.
 */
export { libre2DirectCgm, libreTransmitterCgm, LIBRE2_DIRECT_ID, LIBRE_TRANSMITTER_ID, type LibreCgmSource, type Libre2DirectSettings, type LibreTransmitterSettings } from './plugins';
export { pairSensor, PairingError, normalizeSensorUid, enableStreamingParameters, type SensorPairingInfo, type PairingErrorCode } from './pairing';
export { LIBRE_SECRET_KEYS } from './storage';
export { libreCrc16 } from './crc';
export { decryptFram, decryptBle, parseBleData, streamingUnlockPayload, activateParameters, type LibreBleResponse } from './libre2-crypto';
export { SensorData, sensorSerialNumber } from './sensor-data';
export { sensorTypeFromPatchInfo, type SensorType, type SensorState } from './sensor-type';
export { glucoseValueFromRaw, calibratedGlucose, type Measurement } from './measurement';
export type { CalibrationInfo } from './calibration';
export { MiaoMiaoTransmitter, BubbleTransmitter } from './transmitters';
export { Libre2DirectTransmitter } from './libre2-direct';
export { LibreReadingProcessor, type LibreUpdateResult, type LibreError } from './processor';
