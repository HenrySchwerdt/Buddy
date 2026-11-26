/**
 * Radio configuration of a RileyLink for MiniMed pumps: port of `PumpOpsSession.configureRadio`
 * and `setRXFilterMode` from MinimedKit (migrated from ps2/rileylink_ios, MIT License,
 * (c) LoopKit Authors). Unlike the Eros pod radio, the 4b/6b coding is done on the host, the radio
 * is set to no software encoding (2-FSK, 16 kbaud).
 */
import { CC111XRegister, RxFilterMode, SoftwareEncodingType, type CC111XRegisterAddress } from '../rileylink/constants';
import type { PumpRegion } from './models';

/** Exponent of the symbol rate (16 kbps). */
const DRATE_E = 0x9;

export interface ConfigurableRadio {
  readonly capabilities: { readonly supportsSoftwareEncoding: boolean };
  resetRadioConfig(): Promise<void>;
  setSoftwareEncoding(type: typeof SoftwareEncodingType.none): Promise<void>;
  updateRegister(address: CC111XRegisterAddress, value: number): Promise<void>;
  setBaseFrequency(megahertz: number): Promise<void>;
}

/** The register values per region (`worldWide`: wide filter; `northAmerica`/`canada`: narrow filter). */
export const REGION_REGISTERS: Readonly<Record<PumpRegion, readonly (readonly [CC111XRegisterAddress, number])[]>> = {
  WW: [
    [CC111XRegister.mdmcfg4, RxFilterMode.wide | DRATE_E],
    [CC111XRegister.mdmcfg1, 0x62],
    [CC111XRegister.mdmcfg0, 0x1a],
    [CC111XRegister.deviatn, 0x13],
  ],
  NA: [
    [CC111XRegister.mdmcfg4, RxFilterMode.narrow | DRATE_E],
    [CC111XRegister.mdmcfg1, 0x61],
    [CC111XRegister.mdmcfg0, 0x7e],
    [CC111XRegister.deviatn, 0x15],
  ],
};

/** Same order as MinimedKit. Re-run after a RileyLink reconnect or radio reset. */
export async function configureMinimedRadio(radio: ConfigurableRadio, region: PumpRegion, frequencyMhz: number): Promise<void> {
  await radio.resetRadioConfig();
  // a RileyLink that last served an Omnipod keeps its Manchester coding on firmware without resetRadioConfig
  if (radio.capabilities.supportsSoftwareEncoding) await radio.setSoftwareEncoding(SoftwareEncodingType.none);
  for (const [address, value] of REGION_REGISTERS[region]) await radio.updateRegister(address, value);
  await radio.setBaseFrequency(frequencyMhz);
}
