/**
 * TypeScript port of DanaKit/Packets/DanaBasalSetTemporary.swift, DanaBasalCancelTemporary.swift,
 * DanaBasalSetSuspendOn.swift, DanaBasalSetSuspendOff.swift, DanaBasalGetRate.swift and
 * DanaLoopSetTemporaryBasal.swift from loopandlearn/DanaKit (MIT, © 2021 Randall Knutson and the
 * DanaKit authors).
 */
import type { Bytes } from '@buddy/core';
import { at, DataStart, DanaPacketType, uint16At, type DanaPacket, type DanaParsed } from '../packet-type';

/** Shared parse of commands whose response is a single status byte (0 = accepted). */
export const parseStatusByte = (data: Bytes): DanaParsed<null> => ({ success: data.length > DataStart && at(data, DataStart) === 0, rawData: data, data: null });

const simple = (name: string, opCode: number): DanaPacket<null> => ({
  name,
  opCode,
  generate: () => new Uint8Array(0),
  parse: parseStatusByte,
});

export interface PacketBasalSetTemporary {
  /** Ratio is in percentage */
  readonly temporaryBasalRatio: number;
  /** Only whole hours are accepted */
  readonly temporaryBasalDuration: number;
}

export const danaBasalSetTemporary = (options: PacketBasalSetTemporary): DanaPacket<null> => ({
  name: 'Basal_SetTemporary',
  opCode: DanaPacketType.OPCODE_BASAL__SET_TEMPORARY_BASAL,
  generate: () => new Uint8Array([options.temporaryBasalRatio & 0xff, options.temporaryBasalDuration & 0xff]),
  parse: parseStatusByte,
});

export const danaBasalCancelTemporary = (): DanaPacket<null> => simple('Basal_CancelTemporary', DanaPacketType.OPCODE_BASAL__CANCEL_TEMPORARY_BASAL);
export const danaBasalSetSuspendOn = (): DanaPacket<null> => simple('Basal_SetSuspendOn', DanaPacketType.OPCODE_BASAL__SET_SUSPEND_ON);
export const danaBasalSetSuspendOff = (): DanaPacket<null> => simple('Basal_SetSuspendOff', DanaPacketType.OPCODE_BASAL__SET_SUSPEND_OFF);

export interface PacketBasalGetRate {
  readonly maxBasal: number;
  readonly basalStep: number;
  /** 24 hourly rates (U/h) of the active profile. */
  readonly basalProfile: readonly number[];
}

export const danaBasalGetRate = (): DanaPacket<PacketBasalGetRate> => ({
  name: 'Basal_GetRate',
  opCode: DanaPacketType.OPCODE_BASAL__GET_BASAL_RATE,
  generate: () => new Uint8Array(0),
  parse(data) {
    // Swift reads 24 rates without a length check; a short message is reported as failure here
    if (data.length < DataStart + 3 + 48) return { success: false, rawData: data, data: null };
    const maxBasal = uint16At(data, DataStart) / 100.0;
    const basalStep = at(data, DataStart + 2) / 100.0;

    const basalProfile: number[] = [];
    for (let i = 0; i < 24; i++) {
      const index = DataStart + 3 + i * 2;
      basalProfile.push(uint16At(data, index) / 100.0);
    }

    return { success: basalStep < 1, rawData: data, data: { maxBasal, basalStep, basalProfile } };
  },
});

/** `LoopTempBasalDuration` */
export const LoopTempBasalDuration = { min15: 150, min30: 160 } as const;
export type LoopTempBasalDuration = (typeof LoopTempBasalDuration)[keyof typeof LoopTempBasalDuration];

export interface PacketLoopSetTemporaryBasal {
  readonly percent: number;
  readonly duration: LoopTempBasalDuration;
}

export const danaLoopSetTemporaryBasal = (options: PacketLoopSetTemporaryBasal): DanaPacket<null> => ({
  name: 'LoopSpecific_SetShortTempBasal',
  opCode: DanaPacketType.OPCODE_BASAL__APS_SET_TEMPORARY_BASAL,
  generate() {
    let percent = options.percent & 0xffff;

    if (percent > 500) {
      percent = 500;
    }

    return new Uint8Array([percent & 0xff, (percent >> 8) & 0xff, options.duration]);
  },
  parse: parseStatusByte,
});
