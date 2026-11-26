/**
 * Eros pod address helpers. Pairing addresses follow `OmniPumpManager.swift` (OmnipodKit, MIT License,
 * (c) LoopKit Authors): a PDM-style 0x1fxxxxxx id with 20 random bits.
 */
/** Address used on the air (and as message address) until a pod has been assigned one. */
export const PAIRING_ADDRESS = 0xffffffff;

const ADDRESS_PREFIX = 0x1f000000;
const RANDOM_MASK = 0x000fffff;

/** `random32` yields a uniform unsigned 32-bit integer (inject a CSPRNG in the app, a stub in tests). */
export const generatePodAddress = (random32: () => number): number => (ADDRESS_PREFIX | (random32() & RANDOM_MASK)) >>> 0;

export const isErosPodAddress = (a: number): boolean => a >>> 24 === 0x1f;
