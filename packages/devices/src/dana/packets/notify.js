import { at, DataStart, DanaPacketType, uint16At } from '../packet-type';
const notifyType = (opCode) => ((DanaPacketType.TYPE_NOTIFY & 0xff) << 8) + opCode;
export function parseNotifyDeliveryComplete(data) {
    return {
        success: data.length >= DataStart + 2,
        notifyType: notifyType(DanaPacketType.OPCODE_NOTIFY__DELIVERY_COMPLETE),
        rawData: data,
        data: { deliveredInsulin: uint16At(data, DataStart) / 100 },
    };
}
export function parseNotifyDeliveryRateDisplay(data) {
    return {
        success: data.length >= DataStart + 2,
        notifyType: notifyType(DanaPacketType.OPCODE_NOTIFY__DELIVERY_RATE_DISPLAY),
        rawData: data,
        data: { deliveredInsulin: uint16At(data, DataStart) / 100 },
    };
}
const DANA_NOTIFY_ALARM = {
    0x01: 'batteryZeroPercent',
    0x02: 'pumpError',
    0x03: 'occlusion',
    0x04: 'lowBattery',
    0x05: 'shutdown',
    0x06: 'basalCompare',
    0x07: 'bloodSugarMeasure',
    0xff: 'bloodSugarMeasure',
    0x08: 'remainingInsulinLevel',
    0xfe: 'remainingInsulinLevel',
    0x09: 'emptyReservoir',
    0x0a: 'checkShaft',
    0x0b: 'basalMax',
    0x0c: 'dailyMax',
    0xfd: 'bloodSugarCheckMiss',
};
export function parseNotifyAlarm(data) {
    const code = at(data, DataStart);
    return {
        success: true,
        notifyType: notifyType(DanaPacketType.OPCODE_NOTIFY__ALARM),
        rawData: data,
        data: { code, alert: DANA_NOTIFY_ALARM[code] ?? 'unknown' },
    };
}
export function parseNotifyMissedBolus(data) {
    return {
        success: at(data, DataStart) !== 0x01 && at(data, DataStart + 1) !== 0x01 && at(data, DataStart + 2) !== 0x01 && at(data, DataStart + 3) !== 0x01,
        notifyType: notifyType(DanaPacketType.OPCODE_NOTIFY__MISSED_BOLUS_ALARM),
        rawData: data,
        data: {
            startTime: (at(data, DataStart) * 3600 + at(data, DataStart + 1) * 60) * 60,
            endTime: (at(data, DataStart + 2) * 3600 + at(data, DataStart + 3) * 60) * 60,
        },
    };
}
