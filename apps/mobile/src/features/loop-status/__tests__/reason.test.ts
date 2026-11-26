import { describe, expect, it } from 'vitest';
import { computedTags, convertConclusion, convertTag, parseReason } from '../reason';
import { GLOSSARY } from '../glossary';

const REASON =
  'Autosens ratio: 1, ISF: 100→90, COB: 0, Dev: -2, BGI: 0, CR: 10, Target: 100, minPredBG 90, minGuardBG 85, IOBpredBG 100; Eventual BG 120 >= 100, temp 0.5 >= req 0.3U/hr.';

describe('parseReason', () => {
  it('splits tags from the conclusion at the first semicolon', () => {
    const { tags, conclusion } = parseReason(REASON);
    expect(tags.slice(0, 3)).toEqual(['Autosens ratio: 1', 'ISF: 100→90', 'COB: 0']);
    expect(tags).toContain('minGuardBG 85');
    expect(conclusion).toBe('Eventual BG 120 >= 100, temp 0.5 >= req 0.3U/hr.');
  });

  it('treats a reason without tags (an error text) as conclusion', () => {
    expect(parseReason('CGM data is unchanged for 30 minutes')).toEqual({ tags: [], conclusion: 'CGM data is unchanged for 30 minutes' });
    expect(parseReason('')).toEqual({ tags: [], conclusion: '' });
  });
});

describe('mmol conversion', () => {
  it('converts glucose tags and leaves the others', () => {
    expect(convertTag('ISF: 100→90', 'mmol/L')).toBe('ISF: 5.5→5');
    expect(convertTag('COB: 20', 'mmol/L')).toBe('COB: 20');
    expect(convertTag('ISF: 100→90', 'mg/dL')).toBe('ISF: 100→90');
  });

  it('converts conclusion glucose values', () => {
    expect(convertConclusion('Eventual BG 120 >= 100, temp 0.5 >= req 0.3U/hr.', 'mmol/L')).toBe('Eventual BG 6.7 >= 5.5, temp 0.5 >= req 0.3U/hr.');
    expect(convertConclusion('minGuardBG 54<70', 'mmol/L')).toBe('MinGuardBG 3<3.9');
  });
});

describe('computedTags', () => {
  it('appends TDD once', () => {
    expect(computedTags(REASON, 31.26, 'mg/dL').at(-1)).toBe('TDD: 31.3');
    expect(computedTags('TDD: 20; x', 20, 'mg/dL').filter((t) => t.startsWith('TDD'))).toHaveLength(1);
  });
});

describe('glossary', () => {
  it('has unique terms', () => {
    expect(new Set(GLOSSARY.map((g) => g.term)).size).toBe(GLOSSARY.length);
  });
});
