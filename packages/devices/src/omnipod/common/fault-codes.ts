/**
 * Fault event helpers on top of the generated table. Port of `OmnipodCommon/FaultEventCode.swift`
 * from OmnipodKit (MIT License, (c) LoopKit Authors).
 */
import { FAULT_EVENT_CODES } from './fault-codes.gen';

export { FAULT_EVENT_CODES };

export interface FaultEventCode {
  readonly raw: number;
  /** camelCase OmnipodKit name, or `unknown0xNN` */
  readonly name: string;
  readonly description: string;
}

export function faultEventCode(raw: number): FaultEventCode {
  const known = FAULT_EVENT_CODES[raw];
  if (known) return { raw, name: known[0], description: known[1] };
  const hexCode = raw.toString(16).padStart(2, '0');
  return { raw, name: `unknown0x${hexCode}`, description: `Unknown fault 0x${hexCode}` };
}

export const hasFault = (code: FaultEventCode): boolean => code.raw !== 0;
export const isOcclusionFault = (code: FaultEventCode): boolean => code.name === 'occluded' || code.name.startsWith('occlusion');
export const formatFault = (code: FaultEventCode): string => `${code.description} (0x${code.raw.toString(16).padStart(2, '0')})`;
