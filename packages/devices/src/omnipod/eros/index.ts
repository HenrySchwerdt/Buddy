/**
 * Omnipod Eros radio layer: TypeScript port of the `Eros/` directory of OmnipodKit
 * (MIT License, (c) LoopKit Authors / Pete Schwamb).
 */
export { ErosMessageTransport, DEFAULT_EROS_TIMING, type ErosMessageTransportOptions, type ErosTransportState, type ErosTiming, type MessageLogger } from './transport';
export { ErosTransportError, type ErosTransportErrorKind } from './errors';
export { PacketType, PacketError, makePacket, encodePacket, decodePacket, fragmentMessage, maxBodyLen, MAX_MESSAGE_FRAGMENT, type Packet, type PacketTypeValue } from './packet';
export { inspectMessage, encodeMessageFrame, type MessageFrame } from './message-frame';
export { crc8 } from './crc8';
export { crc16 } from './crc16';
export { createNonceState, advanceNonce, currentNonce, resyncNonceState, type NonceState } from './nonce';
export { PAIRING_ADDRESS, generatePodAddress, isErosPodAddress } from './address';
export { configureErosRadio, EROS_BASE_FREQUENCY_MHZ, EROS_PREAMBLE, EROS_REGISTER_SETTINGS, type ConfigurableRadio } from './radio-config';
export { ErosPodSimulator, type ErosPodSimulatorOptions } from './simulator';
