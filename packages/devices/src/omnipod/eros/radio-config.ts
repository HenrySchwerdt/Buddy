/**
 * Radio configuration for Eros pods, ported from `CommandSession.configureRadio()` in
 * `Eros/ErosPodComms.swift` (OmnipodKit, MIT License, (c) LoopKit Authors / Pete Schwamb).
 * The RileyLink firmware does the Manchester coding (software encoding), so the host never encodes bits.
 */
import { CC111XRegister, SoftwareEncodingType, type CC111XRegisterAddress } from '../../rileylink/constants';

export const EROS_BASE_FREQUENCY_MHZ = 433.91;
export const EROS_PREAMBLE = 0x6665;

export const EROS_REGISTER_SETTINGS: readonly (readonly [CC111XRegisterAddress, number])[] = [
  [CC111XRegister.pktctrl1, 0x20],
  [CC111XRegister.pktctrl0, 0x00],
  [CC111XRegister.fsctrl1, 0x06],
  [CC111XRegister.mdmcfg4, 0xca],
  [CC111XRegister.mdmcfg3, 0xbc], // 0xbb for the next lower bitrate
  [CC111XRegister.mdmcfg2, 0x06],
  [CC111XRegister.mdmcfg1, 0x70],
  [CC111XRegister.mdmcfg0, 0x11],
  [CC111XRegister.deviatn, 0x44],
  [CC111XRegister.mcsm0, 0x18],
  [CC111XRegister.foccfg, 0x17],
  [CC111XRegister.fscal3, 0xe9],
  [CC111XRegister.fscal2, 0x2a],
  [CC111XRegister.fscal1, 0x00],
  [CC111XRegister.fscal0, 0x1f],
  [CC111XRegister.test1, 0x31],
  [CC111XRegister.test0, 0x09],
  [CC111XRegister.paTable0, 0x84],
  [CC111XRegister.sync1, 0xa5],
  [CC111XRegister.sync0, 0x5a],
];

/** The slice of RileyLinkDevice needed to configure the radio. */
export interface ConfigurableRadio {
  setSoftwareEncoding(type: typeof SoftwareEncodingType.manchester): Promise<void>;
  setPreamble(value: number): Promise<void>;
  setBaseFrequency(megahertz: number): Promise<void>;
  updateRegister(address: CC111XRegisterAddress, value: number): Promise<void>;
}

/** Same order as OmnipodKit. Re-run after a RileyLink reconnect or radio reset. */
export async function configureErosRadio(radio: ConfigurableRadio): Promise<void> {
  await radio.setSoftwareEncoding(SoftwareEncodingType.manchester);
  await radio.setPreamble(EROS_PREAMBLE);
  await radio.setBaseFrequency(EROS_BASE_FREQUENCY_MHZ);
  for (const [reg, value] of EROS_REGISTER_SETTINGS) await radio.updateRegister(reg, value);
}
