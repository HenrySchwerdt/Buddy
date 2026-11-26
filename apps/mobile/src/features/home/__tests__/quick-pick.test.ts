import { describe, expect, it } from 'vitest';
import { displayedSuggestions, outcomeAlert, quickPickSuggestions, slideLabel, topQuickPickSuggestions } from '../quick-pick';

const DAY = 86_400_000;
const NOW = new Date(2026, 10, 26, 12, 0).getTime(); // Thursday noon
const at = (daysAgo: number, hour = 12) => new Date(2026, 10, 26 - daysAgo, hour, 0).getTime();

describe('topQuickPickSuggestions', () => {
  it('ranks the amount most often used around this time first', () => {
    const samples = [
      ...[1, 2, 3, 4].map((d) => ({ amount: 4, timestamp: at(d) })),
      { amount: 2, timestamp: at(1) },
      { amount: 9, timestamp: at(1, 3) }, // night: far from noon
    ];
    expect(topQuickPickSuggestions(samples, 0, NOW)[0]).toBe(4);
  });
  it('floors bolus amounts to 0.1 U like Trio (1.15 becomes 1.1)', () => {
    expect(topQuickPickSuggestions([{ amount: 1.15, timestamp: NOW - 1000 }], 1, NOW, 'down')).toEqual([1.1]);
  });
  it('drops entries whose score stays under the 0.1 floor', () => {
    expect(topQuickPickSuggestions([{ amount: 3, timestamp: at(89, 0) }], 0, NOW)).toEqual([]);
  });
  it('weights weekdays over weekend mismatches and older entries less', () => {
    const weekend = at(5); // Saturday
    const recentWeekday = at(1);
    const out = topQuickPickSuggestions([{ amount: 10, timestamp: weekend }, { amount: 20, timestamp: recentWeekday }], 0, NOW);
    expect(out).toEqual([20, 10]);
  });
});

describe('quickPickSuggestions', () => {
  it('filters by max bolus / max carbs and the 90 day lookback before ranking', () => {
    const res = quickPickSuggestions(
      { boluses: [{ amount: 12, timestamp: at(1) }, { amount: 3, timestamp: at(1) }, { amount: 3, timestamp: NOW - 91 * DAY }], carbs: [{ amount: 400, timestamp: at(1) }, { amount: 30, timestamp: at(1) }] },
      { maxBolus: 10, maxCarbs: 250 },
      NOW,
    );
    expect(res.bolus).toEqual([3]);
    expect(res.carbs).toEqual([30]);
  });
});

describe('displayedSuggestions', () => {
  it('keeps the top three, de-duplicated, ascending', () => expect(displayedSuggestions([5, 2, 5, 9, 1])).toEqual([2, 5]));
});

describe('slide label and outcome alerts', () => {
  it('names what the slide does', () => {
    expect(slideLabel(1, 20)).toBe('Slide to Log and Enact');
    expect(slideLabel(1, null)).toBe('Slide to Enact');
    expect(slideLabel(null, 20)).toBe('Slide to Log');
    expect(slideLabel(null, null)).toBe('Slide to Confirm');
  });
  it('closes silently when everything requested succeeded', () => {
    expect(outcomeAlert({ carbs: 'succeeded', bolus: 'succeeded' })).toBeNull();
    expect(outcomeAlert({ carbs: null, bolus: 'succeeded' })).toBeNull();
  });
  it('reports partial failures and only lets a total failure be retried', () => {
    expect(outcomeAlert({ carbs: 'succeeded', bolus: 'failed', bolusFailureMessage: 'Pump busy' })).toMatchObject({ title: 'Bolus Not Enacted', message: 'Carbs were logged. Pump busy', dismissesSheet: true });
    expect(outcomeAlert({ carbs: 'failed', bolus: 'succeeded' })).toMatchObject({ title: 'Carbs Not Logged', dismissesSheet: true });
    expect(outcomeAlert({ carbs: 'failed', bolus: 'failed' })).toMatchObject({ title: 'Nothing Was Saved', dismissesSheet: false });
    expect(outcomeAlert({ carbs: null, bolus: 'failed' })).toMatchObject({ title: 'Bolus Not Enacted', dismissesSheet: false });
    expect(outcomeAlert({ carbs: 'failed', bolus: null })).toMatchObject({ title: 'Carbs Not Logged', dismissesSheet: false });
  });
});
