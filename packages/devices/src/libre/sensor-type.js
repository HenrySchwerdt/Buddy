export const SensorFamily = { libre: 0, librePro: 1, libre2: 3, libreSense: 7 };
export function sensorFamilyFromRaw(raw) {
    return Object.values(SensorFamily).includes(raw) ? raw : null;
}
/** `SensorType(patchInfo:)`. */
export function sensorTypeFromPatchInfo(patchInfo) {
    switch (patchInfo[0]) {
        case 0xdf:
        case 0xa2:
            return 'Libre 1';
        case 0xe5:
        case 0xe6:
            return 'Libre US 14d';
        case 0x70:
            return 'Libre Pro/H';
        case 0xc5:
        case 0x9d:
        case 0xc6:
        case 0x7f:
            return 'Libre 2';
        case 0x76:
            if (patchInfo[3] === 0x02)
                return 'Libre 2 US';
            if (patchInfo[3] === 0x04)
                return 'Libre 2 CA';
            return (patchInfo[2] ?? 0) >> 4 === 7 ? 'Libre Sense' : 'Libre';
        default:
            return patchInfo.length === 24 ? 'Libre 3' : 'Libre';
    }
}
/** `SensorState(stateByte:)`. */
export function sensorStateFromByte(stateByte) {
    switch (stateByte) {
        case 1: return 'notYetStarted';
        case 2: return 'starting';
        case 3: return 'ready';
        case 4: return 'expired';
        case 5: return 'shutdown';
        case 6: return 'failure';
        default: return 'unknown';
    }
}
