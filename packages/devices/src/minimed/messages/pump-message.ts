/**
 * TypeScript port of `Messages/PumpMessage.swift` and `PumpManager/PumpMessage+PumpOpsSession.swift`
 * from MinimedKit (migrated from ps2/rileylink_ios, MIT License, (c) LoopKit Authors): a packet
 * type, the 3 byte pump address, a message type and a body.
 */
import { concatBytes, fromHex, hex, type Bytes } from '@buddy/core';
import { decodeBody, shortBody, type MessageBody } from './bodies';
import { isMessageType, isPacketType, messageTypeName, PacketType, type PacketTypeValue } from './message-type';

export interface PumpMessage {
  readonly packetType: PacketTypeValue;
  /** 3 bytes: the pump serial number as BCD (serial "123456" is 0x12 0x34 0x56). */
  readonly address: Bytes;
  readonly messageType: number;
  readonly body: MessageBody;
}

/** The pump serial ("123456") as the 3 address bytes; null unless it is exactly 6 digits. */
export function pumpAddress(pumpId: string): Bytes | null {
  return /^[0-9]{6}$/.test(pumpId) ? fromHex(pumpId) : null;
}

/** `PumpMessage(pumpID:type:body:)`: a Carelink message to the pump. */
export function carelinkMessage(address: Bytes, messageType: number, body: MessageBody = shortBody()): PumpMessage {
  return { packetType: PacketType.carelink, address, messageType, body };
}

export function encodePumpMessage(m: PumpMessage): Bytes {
  return concatBytes(Uint8Array.of(m.packetType), m.address.subarray(0, 3), Uint8Array.of(m.messageType), m.body.txData);
}

/** Null for anything that is not a well-formed message of a known type (`PumpMessage.init?(rxData:)`). */
export function decodePumpMessage(rx: Bytes): PumpMessage | null {
  if (rx.length < 6) return null;
  const packetType = rx[0]!;
  const messageType = rx[4]!;
  if (!isPacketType(packetType) || packetType === PacketType.meter || !isMessageType(messageType)) return null;
  const body = decodeBody(messageType, rx.slice(5));
  if (!body) return null;
  return { packetType, address: rx.slice(1, 4), messageType, body };
}

/** For logs: the message type only, never the address or the payload. */
export const describeMessage = (m: PumpMessage): string => `${messageTypeName(m.messageType)}(${m.body.kind})`;

export const addressHex = (m: PumpMessage): string => hex(m.address);
