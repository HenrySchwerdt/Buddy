import { describe, expect, it } from 'vitest';
import { DEFAULT_ALERT_SETTINGS } from '@buddy/core';
import { activeAlarmFor, toneFor } from '../alert-sound';
import { newAlarm, type GlucoseAlarm } from '../../features/settings-b/alarms';

const quiet = { ...DEFAULT_ALERT_SETTINGS.quietHours, enabled: true, startMinute: 22 * 60, endMinute: 7 * 60, utcOffsetMinutes: 0 };
const NOON = Date.UTC(2026, 10, 25, 12);
const NIGHT = Date.UTC(2026, 10, 25, 2);
const low = (over: Partial<GlucoseAlarm>): GlucoseAlarm => ({ ...newAlarm('low', 'always'), ...over });

describe('activeAlarmFor', () => {
  it('picks the alarm whose window is current', () => {
    const day = low({ id: 'd', window: 'day', soundId: 'chime' });
    const night = low({ id: 'n', window: 'night', soundId: 'siren' });
    expect(activeAlarmFor([day, night], 'low', quiet, NOON)?.id).toBe('d');
    expect(activeAlarmFor([day, night], 'low', quiet, NIGHT)?.id).toBe('n');
  });
  it('ignores disabled alarms and kinds without alarms', () => {
    expect(activeAlarmFor([low({ enabled: false })], 'low', quiet, NOON)).toBeNull();
    expect(activeAlarmFor([], 'staleData', quiet, NOON)).toBeNull();
  });
});

describe('toneFor', () => {
  it('uses the alarm tone, silence, or the default', () => {
    expect(toneFor(low({ soundId: 'siren', playsSound: true }))).toEqual({ sound: 'siren.wav', channelId: 'buddy-alarm-siren' });
    expect(toneFor(low({ playsSound: false })).sound).toBe(false);
    expect(toneFor(null).sound).toBe(true);
  });
});
