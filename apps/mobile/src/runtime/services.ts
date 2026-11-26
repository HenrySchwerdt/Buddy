import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { create } from 'zustand';
import { evaluateAlerts, snoozeAlert, type Alert, type AlertKind, type LoopRun, type PumpState } from '@buddy/core';
import { createNightscoutUploader, type NightscoutUploader, type ProfileUploadInput } from '@buddy/nightscout';
import { Platform } from 'react-native';
import { activeAlarmFor, toneChannel, toneFile, toneFor } from './alert-sound';
import { resolveAlertSettings, type GlucoseAlarm } from '../features/settings-b/alarms';
import { ALARM_SOUND_IDS } from './alarm-sound-ids';
import { readPhoneStatus } from './phone-status';
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
  const asked = await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowSound: true, allowCriticalAlerts: true, allowBadge: true } });
  return asked.granted;
}

let alarmSource: () => readonly GlucoseAlarm[] = () => [];
/** The glucose alarm list (Settings > Notifications > Glucose Alarms); set at startup. */
export function setAlarmSource(fn: () => readonly GlucoseAlarm[]): void {
  alarmSource = fn;
}

const channels = new Set<string>();
async function ensureToneChannel(soundId: string | null): Promise<string> {
  if (Platform.OS !== 'android') return 'default';
  const id = soundId ? toneChannel(soundId) : toneChannel('silent');
  if (channels.has(id)) return id;
  await Notifications.setNotificationChannelAsync(id, {
    name: soundId ? `Alarm tone ${soundId}` : 'Silent alarms',
    importance: Notifications.AndroidImportance.HIGH,
    sound: soundId ? toneFile(soundId) : null,
    enableVibrate: true,
    bypassDnd: false,
  });
  channels.add(id);
  return id;
}

export async function processAlerts(now: number, input: { glucose: Parameters<typeof evaluateAlerts>[0]['glucose']; lastRun: LoopRun | null; lastOk: number | null; pump: PumpState | null }) {
  const s = useSettings.getState();
  const alarms = alarmSource();
  // Day / Night windows: the alarm list decides which alarm of each kind is on right now.
  const base = { ...s.alerts, unit: s.units };
  const settings = alarms.length > 0 ? { ...resolveAlertSettings(alarms, base, now), unit: s.units } : base;
  const { active, toNotify } = evaluateAlerts({
    now,
    glucose: input.glucose,
    lastLoopRun: input.lastRun,
    lastSuccessfulLoopAt: input.lastOk,
    pump: input.pump,
    settings,
    snoozes: s.alertSnoozes,
    previouslyActive: useAlerts.getState().active,
  });
  useAlerts.setState({ active });
  if (toNotify.length === 0 || !(await ensurePermission().catch(() => false))) return;
  for (const a of toNotify) {
    const alarm = activeAlarmFor(alarms, a.kind, settings.quietHours, now);
    const tone = toneFor(alarm);
    const known = alarm && ALARM_SOUND_IDS.includes(alarm.soundId);
    const channelId = Platform.OS === 'android' ? await ensureToneChannel(known && alarm?.playsSound ? alarm.soundId : null).catch(() => 'default') : undefined;
    await Notifications.scheduleNotificationAsync({
      identifier: `buddy-${a.kind}`,
      content: {
        title: a.title,
        body: a.body,
        // iOS plays the named bundled file; Android takes the sound from the channel.
        sound: Platform.OS === 'ios' && known ? tone.sound : alarm && !alarm.playsSound ? false : true,
        interruptionLevel: a.severity === 'critical' ? 'critical' : 'timeSensitive',
        data: { kind: a.kind },
      },
      trigger: channelId && channelId !== 'default' ? { channelId } : null,
    }).catch(() => {});
  }
}

export function snooze(kind: AlertKind, minutes: number, now: number) {
  const s = useSettings.getState();
  s.update({ alertSnoozes: snoozeAlert(s.alertSnoozes, kind, now + minutes * 60_000, now) });
  useAlerts.setState({ active: useAlerts.getState().active.filter((a) => a.kind !== kind) });
  void Notifications.dismissNotificationAsync(`buddy-${kind}`).catch(() => {});
}

export interface NightscoutAccess {
  readonly url: string;
  readonly token: string;
}

/** Site URL and token of the connected Nightscout, or null when not connected. The token never leaves the keychain except into requests. */
export async function nightscoutAccess(): Promise<NightscoutAccess | null> {
  const url = useSettings.getState().nightscoutUrl;
  if (!url) return null;
  return { url, token: (await SecureStore.getItemAsync(NIGHTSCOUT_TOKEN_KEY)) ?? '' };
}

const nsLog = { info: () => {}, warn: (m: string) => console.warn(`[nightscout] ${m}`), error: (m: string) => console.warn(`[nightscout] ${m}`) };

let uploader: NightscoutUploader | null = null;
let uploaderKey = '';

async function getUploader(now: () => number): Promise<NightscoutUploader | null> {
  const s = useSettings.getState();
  if (!s.nightscoutUpload) return null;
  const access = await nightscoutAccess();
  if (!access) return null;
  const key = `${access.url}|${access.token}`;
  if (!uploader || key !== uploaderKey) {
    uploaderKey = key;
    uploader = createNightscoutUploader({
      url: access.url,
      token: access.token || undefined,
      fetch: globalThis.fetch.bind(globalThis),
      clock: { now },
      log: nsLog,
      initialState: s.nightscoutState as never,
    });
  }
  return uploader;
}

export const useUploadStatus = create<{ lastOk: number | null; lastError: string | null }>(() => ({ lastOk: null, lastError: null }));

export type NightscoutUploadSnapshot = Omit<Parameters<NightscoutUploader['upload']>[0], 'uploader'>;

export async function uploadToNightscout(now: () => number, snapshot: NightscoutUploadSnapshot) {
  const u = await getUploader(now).catch(() => null);
  if (!u) return;
  const s = useSettings.getState();
  const result = await u.upload({
    ...snapshot,
    // Sensor sessions only go out when the user enabled "Upload CGM Sensor States".
    sensors: s.nightscoutUploadSensors ? snapshot.sensors : [],
    uploader: await readPhoneStatus(),
  });
  if (result.skipped) return;
  const failed = Object.entries(result.collections).filter(([, r]) => !r.ok);
  useUploadStatus.setState(failed.length ? { lastError: failed.map(([k, r]) => `${k}: ${'error' in r ? r.error : ''}`).join(', ') } : { lastOk: now(), lastError: null });
  useSettings.getState().update({ nightscoutState: u.getState() as unknown as Record<string, number> });
}

const timezone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

/** Trio `uploadProfiles`: sends basal, ISF, carb ratio, targets and override presets. Needs upload enabled and a connected site. */
export async function uploadNightscoutProfile(now: () => number, remote?: Pick<ProfileUploadInput, 'bundleIdentifier' | 'deviceToken' | 'isAPNSProduction' | 'teamID' | 'remoteCommands'> | null): Promise<{ ok: boolean; error?: string }> {
  const u = await getUploader(now).catch(() => null);
  if (!u) return { ok: true };
  const s = useSettings.getState();
  const r = await u.uploadProfile({ profile: s.profile, units: s.units, timezone: timezone(), now: now(), overridePresets: s.overridePresets, ...(remote ?? {}) });
  if (!r.ok) {
    useUploadStatus.setState({ lastError: r.error });
    return { ok: false, error: r.error };
  }
  return { ok: true };
}

export type NightscoutDeletion = { readonly kind: 'carbs' | 'insulin'; readonly id: string } | { readonly kind: 'glucose'; readonly id: string; readonly date: number };

/** Removes a record from Nightscout (Trio `deleteCarbs` / `deleteInsulin` / `deleteGlucose`). No-op without upload. */
export async function deleteFromNightscout(now: () => number, d: NightscoutDeletion): Promise<{ ok: boolean; error?: string }> {
  const u = await getUploader(now).catch(() => null);
  if (!u) return { ok: true };
  const r = d.kind === 'glucose' ? await u.deleteGlucose(d.id, d.date) : await u.deleteTreatment(d.id);
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

/** Free-text `Note` treatment (Trio `uploadNoteTreatment`), used for remote control audit notes. */
export async function uploadNightscoutNote(now: () => number, note: string): Promise<void> {
  const u = await getUploader(now).catch(() => null);
  if (u) await u.uploadNote(note);
}
