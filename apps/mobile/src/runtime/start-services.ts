import { updateGlucoseBadge } from './badge';
import { resetCalendarEvent, updateCalendarEvent } from './calendar';
import { syncHealth } from './health/health';
import { startNightscoutSync } from './nightscout-sync';
import { setAlarmSource } from './services';
import type { ServiceHost } from './service-host';
import { useSettings } from './settings-store';
import { setTidepoolHost, uploadToTidepool } from './tidepool';

/** Wires the optional services (Nightscout download + profile, Health, calendar, badge, Tidepool, remote control) to the runtime. */

/** Services that run after every loop cycle. Each one handles its own failures. */
export async function runPostLoopServices(host: ServiceHost, bolusIncrement?: number): Promise<void> {
  await Promise.allSettled([syncHealth(host, bolusIncrement), updateCalendarEvent(host), updateGlucoseBadge(host), uploadToTidepool(host)]);
}

let started = false;

/** Idempotent. Starts the Nightscout tick, settings reactions and the push receiver. */
export function startServices(host: ServiceHost): void {
  if (started) return;
  started = true;
  setTidepoolHost(host);
  startNightscoutSync(host);
  host.store.subscribe(() => void updateGlucoseBadge(host));
  useSettings.subscribe((s, prev) => {
    if (s.glucoseBadge !== prev.glucoseBadge || s.units !== prev.units) void updateGlucoseBadge(host);
    if (s.useCalendar !== prev.useCalendar || s.calendarTitle !== prev.calendarTitle || s.displayCalendarEmojis !== prev.displayCalendarEmojis || s.displayCalendarIOBandCOB !== prev.displayCalendarIOBandCOB) {
      resetCalendarEvent();
      void updateCalendarEvent(host);
    }
    if (s.useHealth && !prev.useHealth) void syncHealth(host);
    if (s.tidepoolUpload && !prev.tidepoolUpload) void uploadToTidepool(host);
  });
  // Lazy: the alarm store imports the runtime.
  void import('../features/settings-b/alarm-store').then((m) => setAlarmSource(() => m.useGlucoseAlarms.getState().alarms)).catch(() => {});
  // Lazy, so the remote-control module (which imports the runtime) is not part of this module's import cycle.
  void import('./remote-control/wiring').then((m) => m.startRemoteControlReceiver()).catch((e: unknown) => console.warn(`[buddy] Remote control receiver failed: ${String(e)}`));
}
