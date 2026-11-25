/**
 * Dexcom G7 / ONE+ CGM plugin. A passive follower of the official app, as in
 * loopandlearn/G7SensorKit (MIT, © 2022 LoopKit Authors), of which the files in this
 * folder are TypeScript ports (see each file header).
 */
import { defineCgm } from '@buddy/core';
import { errorOf, ReadingBuffer } from '../dexcom-g6/ble-common';
import { DEXCOM_G7_ID, EMPTY_G7_STATE, G7CgmManager, parseG7State, serializeG7State } from './manager';
import { G7Sensor } from './sensor';
export * from './messages';
export { G7CgmManager, parseG7State, serializeG7State, EMPTY_G7_STATE, DEXCOM_G7_ID, SUSPECTED_SESSION_END_GRACE_MS } from './manager';
export { G7Sensor, DEFAULT_G7_TIMING } from './sensor';
export const G7_STATE_KEY = `${DEXCOM_G7_ID}.state`;
const SENSOR_NAME_PATTERN = /^(DXCM|DX02)[0-9A-Z]{2}$/;
export function normalizeSensorName(raw) {
    const name = raw.trim().toUpperCase();
    if (name === '')
        return null;
    if (!SENSOR_NAME_PATTERN.test(name))
        throw new Error('Dexcom G7 sensor name must look like DXCM1A (or DX02xx for ONE+), or be left empty');
    return name;
}
const META = {
    id: DEXCOM_G7_ID,
    name: 'Dexcom G7 (Bluetooth)',
    manufacturer: 'Dexcom',
    description: 'Reads a Dexcom G7 / ONE+ sensor over Bluetooth by following the official Dexcom app (which must stay installed and connected).',
    transport: 'ble',
    maturity: 'experimental',
};
export function createDexcomG7Source(settings, ctx, options = {}) {
    const ble = ctx.ble;
    if (!ble)
        throw new Error('Dexcom G7 needs Bluetooth, but no BLE transport is available on this device');
    const pinnedName = normalizeSensorName(String(settings.sensorName ?? ''));
    const buffer = new ReadingBuffer();
    let manager = null;
    let persistChain = Promise.resolve();
    const persist = (state) => {
        const secrets = ctx.secrets;
        if (!secrets)
            return;
        persistChain = persistChain
            .then(() => secrets.set(G7_STATE_KEY, serializeG7State(state)))
            .catch((e) => ctx.log.error(`Dexcom G7: could not persist state: ${errorOf(e).message}`));
    };
    return {
        meta: META,
        async start() {
            if (manager?.sensor.isRunning)
                return;
            if (!manager) {
                let state = parseG7State((await ctx.secrets?.get(G7_STATE_KEY)) ?? null);
                if (pinnedName && state.sensorID !== pinnedName)
                    state = { ...EMPTY_G7_STATE, sensorID: pinnedName };
                const restored = state !== EMPTY_G7_STATE;
                manager = new G7CgmManager(state, {
                    clock: ctx.clock,
                    log: ctx.log,
                    persist,
                    suspectedSessionEndGraceMs: options.suspectedSessionEndGraceMs,
                    onReadings: (rs) => rs.forEach(({ syncId, reading }) => buffer.add(syncId, reading)),
                    makeSensor: (delegate, sensorID) => new G7Sensor({ sensorID, ble, clock: ctx.clock, log: ctx.log, delegate, timing: options.timing }),
                });
                if (restored)
                    manager.sensor.needsVersionInfo = manager.state.extendedVersion === null;
            }
            else {
                manager.restorePendingSuspectedSessionEnd();
            }
            manager.sensor.resumeScanning();
        },
        async stop() {
            manager?.dispose();
            await manager?.sensor.stopScanning();
            await persistChain;
        },
        async readings(since) {
            return buffer.since(since);
        },
    };
}
export const dexcomG7Cgm = defineCgm({
    meta: META,
    settings: [
        {
            title: 'Sensor',
            fields: [
                {
                    kind: 'text',
                    key: 'sensorName',
                    label: 'Sensor name (optional)',
                    placeholder: 'DXCM1A',
                    help: 'Leave empty to follow the next sensor the Dexcom app connects to. A new sensor is picked up automatically when the session ends.',
                },
            ],
        },
    ],
    defaultSettings: { sensorName: '' },
    create: (settings, ctx) => createDexcomG7Source(settings, ctx),
});
