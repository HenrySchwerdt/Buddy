import { describe, expect, it } from 'vitest';
import { closedLoopBlockReason } from '../closed-loop-gate';

const demoPump = { id: 'demo-pump', name: 'Demo Pump', maturity: 'simulator' as const };
const demoCgm = { id: 'demo-cgm', name: 'Demo CGM', maturity: 'simulator' as const };
const medtrum = { id: 'medtrum-nano', name: 'Medtrum Nano', maturity: 'experimental' as const, requiresHardwareCheck: true };
const dexcom = { id: 'dexcom-g7', name: 'Dexcom G7', maturity: 'experimental' as const };
const follower = { id: 'nightscout-follower', name: 'Follower', maturity: 'stable' as const, readOnly: true };
const libreLinkUp = { id: 'libre-link-up', name: 'LibreLinkUp', maturity: 'experimental' as const, transport: 'network' as const };

describe('closedLoopBlockReason', () => {
  it('allows the demo pump with the demo CGM', () => {
    expect(closedLoopBlockReason(demoPump, demoCgm, {})).toBeNull();
  });

  it('blocks when a device is missing', () => {
    expect(closedLoopBlockReason(undefined, demoCgm, {})).toMatch(/No pump or CGM/);
    expect(closedLoopBlockReason(demoPump, undefined, {})).toMatch(/No pump or CGM/);
  });

  it('blocks a read-only pump', () => {
    expect(closedLoopBlockReason(follower, dexcom, {})).toMatch(/Shadow mode/);
  });

  it('blocks a demo pump against real glucose', () => {
    expect(closedLoopBlockReason(demoPump, dexcom, {})).toMatch(/demo pump cannot dose/);
  });

  it('blocks a real pump against simulated glucose, even after the hardware check', () => {
    expect(closedLoopBlockReason(medtrum, demoCgm, { 'medtrum-nano': 1 })).toMatch(/must never dose against simulated glucose/);
  });

  it('blocks an experimental pump until its hardware check is done', () => {
    expect(closedLoopBlockReason(medtrum, dexcom, {})).toMatch(/hardware check/);
    expect(closedLoopBlockReason(medtrum, dexcom, { 'medtrum-nano': 1 })).toBeNull();
  });

  it('blocks a delayed cloud CGM until its use for closed loop is acknowledged', () => {
    const pumpChecked = { 'medtrum-nano': 1 };
    expect(closedLoopBlockReason(medtrum, libreLinkUp, pumpChecked)).toMatch(/cloud/i);
    expect(closedLoopBlockReason(medtrum, libreLinkUp, { ...pumpChecked, 'libre-link-up': 1 })).toBeNull();
  });
});
