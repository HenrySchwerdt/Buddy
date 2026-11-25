import { at, DataStart, DanaPacketType, uint16At } from '../packet-type';
import { parseStatusByte } from './basal';
export const BolusSpeed = {
    speed12: 0,
    speed30: 1,
    speed60: 2,
};
/** Seconds per unit (`estimatedDuration(toBolus:)` in DanaKitPumpManager.swift). */
export const secondsPerUnit = (speed) => (speed === BolusSpeed.speed12 ? 12 : speed === BolusSpeed.speed30 ? 30 : 60);
/** Float tolerance so that e.g. 0.29 × 100 = 28.999999999999996 is not truncated to 28. */
const HUNDREDTHS_EPSILON = 1e-6;
/**
 * Units → pump hundredths, truncated (never rounded up). Swift uses `UInt16(amount * 100)`, which
 * truncates float artefacts like 0.29 to 0.28; the epsilon avoids that while still truncating.
 */
export const toHundredths = (amount) => Math.floor(amount * 100 + HUNDREDTHS_EPSILON);
export const danaBolusStart = (options) => ({
    name: 'Bolus_Start',
    opCode: DanaPacketType.OPCODE_BOLUS__SET_STEP_BOLUS_START,
    generate() {
        const bolusRate = toHundredths(options.amount) & 0xffff;
        return new Uint8Array([bolusRate & 0xff, (bolusRate >> 8) & 0xff, options.speed]);
    },
    parse: parseStatusByte,
});
/**
 * Error codes:
 * 0x01 => Pump suspended
 * 0x04 => Bolus timeout active
 * 0x10 => Max bolus violation
 * 0x20 => Command error (Unknown what this error means)
 * 0x40 => Speed error (Can only happen during development)
 * 0x80 => Insulin limit violation
 */
export function transformBolusError(code) {
    switch (code) {
        case 0x01:
            return 'Pump is suspended';
        case 0x04:
            return 'Bolus timeout active';
        case 0x10:
            return 'Max bolus violation';
        case 0x20:
            return 'bolusCommandError';
        case 0x40:
            return 'Invalid bolus speed error';
        case 0x80:
            return 'Insulin limit violation';
        default:
            return `Unknown error: ${code}`;
    }
}
export const danaBolusStop = () => ({
    name: 'Bolus_Stop',
    opCode: DanaPacketType.OPCODE_BOLUS__SET_STEP_BOLUS_STOP,
    generate: () => new Uint8Array(0),
    parse: parseStatusByte,
});
export const danaBolusGetStepInformation = (now = Date.now) => ({
    name: 'Bolus_GetStepInformation',
    opCode: DanaPacketType.OPCODE_BOLUS__GET_STEP_BOLUS_INFORMATION,
    generate: () => new Uint8Array(0),
    parse(data) {
        if (data.length < DataStart + 11)
            return { success: false, rawData: data, data: null };
        // Calendar.current.date(bySettingHour:minute:second:of: Date())
        const t = new Date(now());
        t.setHours(at(data, DataStart + 4), at(data, DataStart + 5), 0, 0);
        return {
            success: at(data, DataStart) === 0,
            rawData: data,
            data: {
                bolusType: at(data, DataStart + 1),
                initialBolusAmount: uint16At(data, DataStart + 2) / 100,
                lastBolusTime: t.getTime(),
                lastBolusAmount: uint16At(data, DataStart + 6) / 100,
                maxBolus: uint16At(data, DataStart + 8) / 100,
                bolusStep: at(data, DataStart + 10),
            },
        };
    },
});
