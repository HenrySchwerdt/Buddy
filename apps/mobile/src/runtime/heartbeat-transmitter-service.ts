import { HeartbeatEmitter, type Clock, type Logger } from '@buddy/core';
import { HeartbeatTransmitter } from '@buddy/devices';
import { useSettings } from './settings-store';
import { bleTransport } from './transports/ble';

/**
 * Owns the one heartbeat transmitter (Trio's "heartbeat transmitter" for CGMs that are not Bluetooth themselves):
 * the BLE device picked in the CGM settings, kept connected so each of its connects, notifications and disconnects
 * wakes the app and requests a loop cycle. Its heartbeats go through `onTransmitterHeartbeat`; the runtime listens
 * to them only when the CGM provides no heartbeat of its own.
 */
const bus = new HeartbeatEmitter();
export const onTransmitterHeartbeat = bus.on;

let current: HeartbeatTransmitter | null = null;

/**
 * Makes the running transmitter match the settings: started when `enabled` and a device is chosen, replaced when the
 * choice changed, stopped otherwise. Safe to call any number of times (restart, restoration, picker).
 */
export async function syncHeartbeatTransmitter(opts: { readonly enabled: boolean; readonly clock: Clock; readonly log: Logger }): Promise<void> {
  const id = useSettings.getState().heartbeatDeviceId;
  if (current && (!opts.enabled || !id || current.deviceId !== id)) {
    const old = current;
    current = null;
    await old.stop();
  }
  if (!opts.enabled || !id || current) return;
  current = new HeartbeatTransmitter({ ble: bleTransport, clock: opts.clock, log: opts.log, deviceId: id, onHeartbeat: bus.emit });
  current.start();
}

export const heartbeatTransmitterConnected = (): boolean => current?.connected ?? false;
