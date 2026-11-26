import * as Notifications from 'expo-notifications';
import { glucoseBadgeValue } from './calendar-text';
import type { ServiceHost } from './service-host';
import { useSettings } from './settings-store';

/** Trio `updateGlucoseBadge`: the current glucose on the app icon; cleared when the setting is off. */

let lastBadge = -1;

async function setBadge(value: number): Promise<void> {
  if (value === lastBadge) return;
  lastBadge = value;
  try {
    await Notifications.setBadgeCountAsync(value);
  } catch (e) {
    lastBadge = -1;
    console.warn(`[buddy] Setting app badge failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function updateGlucoseBadge(host: ServiceHost): Promise<void> {
  const s = useSettings.getState();
  if (!s.glucoseBadge || host.isDemo()) {
    await setBadge(0);
    return;
  }
  const last = host.store.snapshot().glucose.at(-1);
  await setBadge(last ? glucoseBadgeValue(last.value, s.units) : 0);
}
