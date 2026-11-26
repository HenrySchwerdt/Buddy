import Storage from 'expo-sqlite/kv-store';
import { getHealthBackend } from './backend';
import { planHealthUpload, pruneLedger, syncIdForDeletion, type HealthKind } from './samples';
import type { ServiceHost } from '../service-host';
import { useSettings } from '../settings-store';

/**
 * Apple Health / Health Connect service (Trio HealthKitManager): after every loop the new glucose, carbs and insulin
 * are written; deleting a record elsewhere deletes it here too. The ledger of written keys lives outside the settings
 * so backdated entries are still picked up and nothing is written twice.
 */

const LEDGER_KEY = 'buddy.health.ledger.v1';

let ledger: Record<string, number> | null = null;
let busy = false;

async function loadLedger(): Promise<Record<string, number>> {
  if (ledger) return ledger;
  try {
    const raw = await Storage.getItem(LEDGER_KEY);
    ledger = raw ? (JSON.parse(raw) as Record<string, number>) : {};
  } catch {
    ledger = {};
  }
  return ledger;
}

export const healthLabel = (): string => getHealthBackend()?.label ?? 'Health';

export interface HealthPermissionResult {
  readonly granted: boolean;
  /** False when glucose may not be written yet: show the "give write permission" hint (Trio `needShowInformationTextForSetPermissions`). */
  readonly glucoseWritable: boolean;
  readonly error?: string;
}

/** Trio `requestPermission`; resolves, never throws. */
export async function requestHealthPermission(): Promise<HealthPermissionResult> {
  const backend = getHealthBackend();
  if (!backend) return { granted: false, glucoseWritable: false, error: 'Health data is not available on this device.' };
  try {
    const granted = await backend.requestPermission();
    return { granted, glucoseWritable: await backend.canWriteGlucose() };
  } catch (e) {
    return { granted: false, glucoseWritable: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function healthGlucoseWritable(): Promise<boolean> {
  try {
    return (await getHealthBackend()?.canWriteGlucose()) ?? false;
  } catch {
    return false;
  }
}

/** Writes what is new. Never throws. */
export async function syncHealth(host: ServiceHost, bolusIncrement?: number): Promise<void> {
  if (busy || host.isDemo() || !useSettings.getState().useHealth) return;
  const backend = getHealthBackend();
  if (!backend) return;
  busy = true;
  try {
    if (!(await backend.canWriteGlucose())) return; // the user has not granted write access (yet)
    const now = host.now();
    const known = await loadLedger();
    const snap = host.store.snapshot();
    const samples = planHealthUpload(snap, { now, uploaded: new Set(Object.keys(known)), ...(bolusIncrement ? { bolusIncrement } : {}) });
    if (samples.length === 0) return;
    const stored = new Set(await backend.write(samples));
    const dateOf = (s: (typeof samples)[number]) => (s.kind === 'insulin' ? s.start : s.date);
    const next = { ...known };
    for (const s of samples) if (stored.has(s.key)) next[s.key] = dateOf(s);
    ledger = pruneLedger(next, now);
    await Storage.setItem(LEDGER_KEY, JSON.stringify(ledger));
  } catch (e) {
    console.warn(`[buddy] Health sync failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    busy = false;
  }
}

/** Removes a record from Health (Trio `deleteGlucose` / `deleteMealData` / `deleteInsulin`), only when the integration is on. */
export async function deleteFromHealth(kind: HealthKind, id: string, date: number): Promise<{ ok: boolean; error?: string }> {
  if (!useSettings.getState().useHealth) return { ok: true };
  const backend = getHealthBackend();
  if (!backend) return { ok: true };
  const syncId = syncIdForDeletion(kind, id, date);
  try {
    // The ledger entry stays, so a record the store still returns (a pump re-reporting a dose) is not written again.
    await backend.remove(kind, syncId);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
