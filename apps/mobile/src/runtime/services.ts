import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { create } from 'zustand';
import { evaluateAlerts, snoozeAlert, type Alert, type AlertKind, type LoopRun, type PumpState } from '@buddy/core';
import { createNightscoutUploader, type NightscoutUploader } from '@buddy/nightscout';
import { useSettings } from './settings-store';

/**
 * Post-loop services: glucose/loop alerts (local notifications) and Nightscout upload.
 * Both run after every loop cycle and never throw into the loop.
 */

export const NIGHTSCOUT_TOKEN_KEY = 'buddy.nightscout.token';

export const useAlerts = create<{ active: readonly Alert[] }>(() => ({ active: [] }));

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

let permissionAsked = false;
async function ensurePermission(): Promise<boolean> {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  if (permissionAsked) return false;
  permissionAsked = true;
  const asked = await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowSound: true, allowCriticalAlerts: true } });
  return asked.granted;
}

export async function processAlerts(now: number, input: { glucose: Parameters<typeof evaluateAlerts>[0]['glucose']; lastRun: LoopRun | null; lastOk: number | null; pump: PumpState | null }) {
  const s = useSettings.getState();
  const { active, toNotify } = evaluateAlerts({
    now,
    glucose: input.glucose,
    lastLoopRun: input.lastRun,
    lastSuccessfulLoopAt: input.lastOk,
    pump: input.pump,
    settings: { ...s.alerts, unit: s.units },
    snoozes: s.alertSnoozes,
    previouslyActive: useAlerts.getState().active,
  });
  useAlerts.setState({ active });
  if (toNotify.length === 0 || !(await ensurePermission().catch(() => false))) return;
  for (const a of toNotify) {
    await Notifications.scheduleNotificationAsync({
      identifier: `buddy-${a.kind}`,
      content: { title: a.title, body: a.body, sound: true, interruptionLevel: a.severity === 'critical' ? 'critical' : 'timeSensitive', data: { kind: a.kind } },
      trigger: null,
    }).catch(() => {});
  }
}

export function snooze(kind: AlertKind, minutes: number, now: number) {
  const s = useSettings.getState();
  s.update({ alertSnoozes: snoozeAlert(s.alertSnoozes, kind, now + minutes * 60_000, now) });
  useAlerts.setState({ active: useAlerts.getState().active.filter((a) => a.kind !== kind) });
  void Notifications.dismissNotificationAsync(`buddy-${kind}`).catch(() => {});
}

let uploader: NightscoutUploader | null = null;
let uploaderKey = '';

async function getUploader(now: () => number): Promise<NightscoutUploader | null> {
  const s = useSettings.getState();
  if (!s.nightscoutUpload || !s.nightscoutUrl) return null;
  const token = (await SecureStore.getItemAsync(NIGHTSCOUT_TOKEN_KEY)) ?? '';
  const key = `${s.nightscoutUrl}|${token}`;
  if (!uploader || key !== uploaderKey) {
    uploaderKey = key;
    uploader = createNightscoutUploader({
      url: s.nightscoutUrl,
      token: token || undefined,
      fetch: globalThis.fetch.bind(globalThis),
      clock: { now },
      log: { info: () => {}, warn: (m) => console.warn(`[nightscout] ${m}`), error: (m) => console.warn(`[nightscout] ${m}`) },
      initialState: s.nightscoutState as never,
    });
  }
  return uploader;
}

export const useUploadStatus = create<{ lastOk: number | null; lastError: string | null }>(() => ({ lastOk: null, lastError: null }));

export async function uploadToNightscout(now: () => number, snapshot: Parameters<NightscoutUploader['upload']>[0]) {
  const u = await getUploader(now).catch(() => null);
  if (!u) return;
  const result = await u.upload(snapshot);
  if (result.skipped) return;
  const failed = Object.entries(result.collections).filter(([, r]) => !r.ok);
  useUploadStatus.setState(failed.length ? { lastError: failed.map(([k, r]) => `${k}: ${'error' in r ? r.error : ''}`).join(', ') } : { lastOk: now(), lastError: null });
  useSettings.getState().update({ nightscoutState: u.getState() as unknown as Record<string, number> });
}
