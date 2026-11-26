import type { AlertKind, AlertSettings } from '@buddy/core';
import { isNightAt, type GlucoseAlarm } from '../features/settings-b/alarms';

/** The alarm of a glucose kind that applies now (the one `resolveAlertSettings` turned on), or null for kinds without alarms. */
export function activeAlarmFor(alarms: readonly GlucoseAlarm[], kind: AlertKind, quiet: AlertSettings['quietHours'], now: number): GlucoseAlarm | null {
  const night = isNightAt(quiet, now);
  const of = alarms.filter((a) => a.kind === kind);
  const active = of.find((a) => a.enabled && (a.window === 'always' || (a.window === 'night' ? night : !night)));
  return active ?? (kind === 'urgentLow' ? (of[0] ?? null) : null);
}

export interface AlertTone {
  /** Bundled sound file (iOS notification sound / Android channel sound), or `true` for the default sound, or false for silent. */
  readonly sound: string | boolean;
  readonly channelId: string;
}

export const toneFile = (soundId: string): string => `${soundId}.wav`;
export const toneChannel = (soundId: string): string => `buddy-alarm-${soundId}`;

/** Sound of the notification for an alert: the alarm's tone, silence when the alarm has none, the default for other alerts. */
export function toneFor(alarm: GlucoseAlarm | null): AlertTone {
  if (!alarm) return { sound: true, channelId: 'default' };
  if (!alarm.playsSound) return { sound: false, channelId: toneChannel('silent') };
  return { sound: toneFile(alarm.soundId), channelId: toneChannel(alarm.soundId) };
}
