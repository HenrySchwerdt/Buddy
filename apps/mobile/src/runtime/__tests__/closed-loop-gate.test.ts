import { describe, expect, it } from 'vitest';
import { closedLoopBlockReason } from '../closed-loop-gate';

const demoPump = { id: 'demo-pump', name: 'Demo Pump', maturity: 'simulator' as const };
const demoCgm = { id: 'demo-cgm', name: 'Demo CGM', maturity: 'simulator' as const };
const medtrum = { id: 'medtrum-nano', name: 'Medtrum Nano', maturity: 'experimental' as const };
const dexcom = { id: 'dexcom-g7', name: 'Dexcom G7', maturity: 'experimental' as const };
const follower = { id: 'nightscout-follower', name: 'Follower', maturity: 'stable' as const, readOnly: true };
const libreLinkUp = { id: 'libre-link-up', name: 'LibreLinkUp', maturity: 'experimental' as const };

describe('closedLoopBlockReason', () => {
  it('allows the demo pump with the demo CGM', () => {
    expect(closedLoopBlockReason(demoPump, demoCgm)).toBeNull();
  });

  it('blocks when a device is missing', () => {
    expect(closedLoopBlockReason(undefined, demoCgm)).toMatch(/No pump or CGM/);
    expect(closedLoopBlockReason(demoPump, undefined)).toMatch(/No pump or CGM/);
  });

  it('blocks a read-only pump', () => {
    expect(closedLoopBlockReason(follower, dexcom)).toMatch(/Shadow mode/);
  });

  it('allows a demo pump against real glucose, as Trio does', () => {
    expect(closedLoopBlockReason(demoPump, dexcom)).toBeNull();
  });

  it('blocks a real pump against simulated glucose', () => {
    expect(closedLoopBlockReason(medtrum, demoCgm)).toMatch(/must never dose against simulated glucose/);
  });

  it('allows any real pump with any real CGM, cloud CGMs included, as Trio does', () => {
    expect(closedLoopBlockReason(medtrum, dexcom)).toBeNull();
    expect(closedLoopBlockReason(medtrum, libreLinkUp)).toBeNull();
  });
});
