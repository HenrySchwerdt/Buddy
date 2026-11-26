/**
 * Service-aware GATT access for the Syai sensor. SyaiKit (MIT, © 2026 Nightscout Foundation)
 * addresses characteristics by UUID alone (SyaiGATTTransport.swift); Buddy's `BleConnection`
 * needs the service as well. Each characteristic has a most-likely service and the others as
 * fallbacks, tried only when the platform reports the characteristic as unknown, so a real
 * failure is never retried (an auth write must not be sent twice).
 */
import type { BleConnection, Bytes } from '@buddy/core';
import { CHARACTERISTIC_SERVICES, SERVICE } from './constants';

export interface SyaiGatt {
  read(characteristic: string): Promise<Bytes>;
  write(characteristic: string, data: Bytes, withResponse: boolean): Promise<void>;
  subscribe(characteristic: string, onData: (data: Bytes) => void): Promise<() => void>;
}

const NOT_FOUND = /not ?found|unknown (characteristic|service)|no such (characteristic|service)|characteristic .*(missing|unavailable)|service .*not/i;

export function createSyaiGatt(conn: BleConnection): SyaiGatt {
  const resolved = new Map<string, string>();

  async function viaServices<T>(characteristic: string, op: (service: string) => Promise<T>): Promise<T> {
    const known = resolved.get(characteristic);
    const candidates = known ? [known] : (CHARACTERISTIC_SERVICES[characteristic] ?? Object.values(SERVICE));
    let lastError: Error | null = null;
    for (const service of candidates) {
      try {
        const result = await op(service);
        resolved.set(characteristic, service);
        return result;
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        if (!NOT_FOUND.test(lastError.message)) throw lastError;
      }
    }
    throw lastError ?? new Error(`Characteristic ${characteristic} not found`);
  }

  return {
    read: (c) => viaServices(c, (s) => conn.read(s, c)),
    write: (c, data, withResponse) => viaServices(c, (s) => conn.write(s, c, data, withResponse)),
    subscribe: (c, onData) => viaServices(c, (s) => conn.subscribe(s, c, onData)),
  };
}
