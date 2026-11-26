import { describe, expect, it } from 'vitest';
import { buildCalendarEvent, formatDelta, glucoseBadgeValue, type CalendarEventInput } from '../calendar-text';

const base: CalendarEventInput = { unit: 'mg/dL', glucose: 120, previousGlucose: 115, trend: 'flat', iob: 1.234, cob: 24.6, loopAgeMinutes: 3, low: 70, high: 180, displayIobAndCob: false, displayEmojis: false, now: 1000 };

describe('buildCalendarEvent', () => {
  it('plain title with direction and delta, 10 minute event', () => {
    expect(buildCalendarEvent(base)).toEqual({ title: '120 → +5', notes: 'Buddy', startDate: 1000, endDate: 1000 + 600_000 });
  });
  it('emoji and IOB/COB', () => {
    const e = buildCalendarEvent({ ...base, displayEmojis: true, displayIobAndCob: true });
    expect(e.title).toBe('🟢 120 → +5');
    expect(e.location).toBe('💉 1.2 🥨 25');
  });
  it('colours: low, high, stale loop', () => {
    expect(buildCalendarEvent({ ...base, displayEmojis: true, glucose: 65 }).title.startsWith('🔴')).toBe(true);
    expect(buildCalendarEvent({ ...base, displayEmojis: true, glucose: 200 }).title.startsWith('🟠')).toBe(true);
    expect(buildCalendarEvent({ ...base, displayEmojis: true, loopAgeMinutes: 20 }).title.startsWith('🚫')).toBe(true);
  });
  it('labels without emojis', () => {
    expect(buildCalendarEvent({ ...base, displayIobAndCob: true }).location).toBe('IOB: 1.2 COB: 25');
  });
  it('mmol/L', () => {
    expect(buildCalendarEvent({ ...base, unit: 'mmol/L', glucose: 126, previousGlucose: 135 }).title).toBe('7 → -0.5'.replace('7 ', '7.0 '));
  });
});

describe('formatDelta / badge', () => {
  it('signs', () => {
    expect(formatDelta(0, 'mg/dL')).toBe('+0');
    expect(formatDelta(-3.4, 'mg/dL')).toBe('-3');
  });
  it('badge value', () => {
    expect(glucoseBadgeValue(123.4, 'mg/dL')).toBe(123);
    expect(glucoseBadgeValue(126, 'mmol/L')).toBe(70);
  });
});
