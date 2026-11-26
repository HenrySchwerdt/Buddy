import { describe, expect, it, vi } from 'vitest';
import { EMPTY_SNAPSHOT, HeartbeatEmitter, MINUTE, silentLogger, type CgmSource, type DataSnapshot, type GlucoseReading, type LoopRun, type PumpDriver } from '@buddy/core';
import { heartbeatSources, startHeartbeatLoop, type HeartbeatLoopDeps } from '../heartbeat-loop';
import { createTaskGuard } from '../task-guard';

const NOW = 1_700_000_000_000;
const reading = (date: number): GlucoseReading => ({ date, value: 120, trend: 'flat', source: 'test' });
const run = (date: number) => ({ date }) as LoopRun;

interface Rig {
  readonly cgmBeats: HeartbeatEmitter;
  readonly pumpBeats: HeartbeatEmitter;
  readonly transmitterBeats: HeartbeatEmitter;
  readonly runLoop: ReturnType<typeof vi.fn>;
  readonly events: string[];
  state: { glucose: GlucoseReading[]; runs: LoopRun[]; cgmReadings: GlucoseReading[]; looping: boolean; now: number };
  deps: HeartbeatLoopDeps;
}

function rig(opts: { cgmHeartbeat?: boolean; pumpHeartbeat?: boolean } = {}): Rig {
  const cgmBeats = new HeartbeatEmitter();
  const pumpBeats = new HeartbeatEmitter();
  const transmitterBeats = new HeartbeatEmitter();
  const events: string[] = [];
  const state = { glucose: [reading(NOW - 6 * MINUTE)], runs: [run(NOW - 6 * MINUTE)], cgmReadings: [] as GlucoseReading[], looping: false, now: NOW };
  const runLoop = vi.fn(async () => {
    events.push('loop');
    state.runs = [...state.runs, run(state.now)];
  });
  const native = { beginBackgroundTask: () => (events.push('begin'), 1), endBackgroundTask: () => void events.push('end') };
  const cgm = {
    meta: { id: 'cgm' },
    readings: async (since: number) => state.cgmReadings.filter((r) => r.date > since),
    ...(opts.cgmHeartbeat === false ? {} : { onHeartbeat: cgmBeats.on }),
  } as unknown as CgmSource;
  const pump = { meta: { id: 'pump' }, ...(opts.pumpHeartbeat ? { onHeartbeat: pumpBeats.on } : {}) } as unknown as PumpDriver;
  const deps: HeartbeatLoopDeps = {
    cgm,
    pump,
    onTransmitterHeartbeat: transmitterBeats.on,
    snapshot: () => ({ ...EMPTY_SNAPSHOT, glucose: state.glucose, loopRuns: state.runs }) as DataSnapshot,
    now: () => state.now,
    isLooping: () => state.looping,
    runLoop,
    afterLoopSettled: async () => void events.push('after'),
    tasks: createTaskGuard(native),
    log: silentLogger,
  };
  return { cgmBeats, pumpBeats, transmitterBeats, runLoop, events, state, deps };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

describe('heartbeat -> loop', () => {
  it('a new reading from the CGM runs the loop immediately, even right after the previous run, inside a background task', async () => {
    const r = rig();
    r.state.runs = [run(NOW - 30_000)];
    r.state.cgmReadings = [reading(NOW - 5_000)];
    startHeartbeatLoop(r.deps);
    r.cgmBeats.emit();
    await settle();
    expect(r.events).toEqual(['begin', 'loop', 'after', 'end']);
  });

  it('a wake-up without a new reading does nothing while the last run is recent', async () => {
    const r = rig();
    r.state.runs = [run(NOW - MINUTE)];
    startHeartbeatLoop(r.deps);
    r.cgmBeats.emit();
    await settle();
    expect(r.runLoop).not.toHaveBeenCalled();
    expect(r.events).toEqual(['begin', 'end']); // the task is still closed again
  });

  it('a wake-up without a reading loops once the last run is older than 4.5 minutes', async () => {
    const r = rig();
    startHeartbeatLoop(r.deps); // last run 6 minutes ago
    r.cgmBeats.emit();
    await settle();
    expect(r.runLoop).toHaveBeenCalledTimes(1);
  });

  it('does not start a cycle while one is running', async () => {
    const r = rig();
    r.state.looping = true;
    r.state.cgmReadings = [reading(NOW)];
    startHeartbeatLoop(r.deps);
    r.cgmBeats.emit();
    await settle();
    expect(r.runLoop).not.toHaveBeenCalled();
  });

  it('ends the task and keeps listening when the cycle throws', async () => {
    const r = rig();
    r.runLoop.mockRejectedValueOnce(new Error('pump unreachable'));
    startHeartbeatLoop(r.deps);
    r.cgmBeats.emit();
    await settle();
    expect(r.events.at(-1)).toBe('end');
    r.cgmBeats.emit();
    await settle();
    expect(r.runLoop).toHaveBeenCalledTimes(2);
  });

  it('a heartbeat that arrives while one is handled is evaluated once more afterwards', async () => {
    const r = rig();
    let release: () => void = () => {};
    r.runLoop.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = () => {
            r.state.runs = [run(r.state.now)];
            resolve();
          };
        }),
    );
    startHeartbeatLoop(r.deps);
    r.cgmBeats.emit();
    await settle();
    r.state.cgmReadings = [reading(NOW + 10_000)]; // a reading arrives during the cycle
    r.cgmBeats.emit();
    release();
    await settle();
    expect(r.runLoop).toHaveBeenCalledTimes(2);
    expect(r.events.filter((e) => e === 'begin')).toHaveLength(1);
  });

  it('stopping unsubscribes', async () => {
    const r = rig();
    const stop = startHeartbeatLoop(r.deps);
    stop();
    r.cgmBeats.emit();
    await settle();
    expect(r.events).toEqual([]);
  });
});

describe('which sources feed the loop (Trio: the pump heartbeats only when the CGM does not)', () => {
  it('a CGM with its own heartbeat is the only source', () => {
    const r = rig({ pumpHeartbeat: true });
    expect(heartbeatSources(r.deps).map((s) => s.name)).toEqual(['cgm']);
  });

  it('without a CGM heartbeat the pump and the heartbeat transmitter are used', async () => {
    const r = rig({ cgmHeartbeat: false, pumpHeartbeat: true });
    expect(heartbeatSources(r.deps).map((s) => s.name)).toEqual(['pump', 'transmitter']);
    startHeartbeatLoop(r.deps);
    r.transmitterBeats.emit(); // last run is 6 minutes old
    await settle();
    expect(r.runLoop).toHaveBeenCalledTimes(1);
  });

  it('a pump without a heartbeat leaves the transmitter', () => {
    const r = rig({ cgmHeartbeat: false });
    expect(heartbeatSources(r.deps).map((s) => s.name)).toEqual(['transmitter']);
  });

  it('cloud CGMs are not asked for readings on a wake-up (it would hit the network)', async () => {
    const r = rig({ cgmHeartbeat: false });
    const readings = vi.fn(async () => [reading(NOW)]);
    startHeartbeatLoop({ ...r.deps, cgm: { meta: { id: 'cloud' }, readings } as unknown as CgmSource });
    r.state.runs = [run(NOW - MINUTE)];
    r.transmitterBeats.emit();
    await settle();
    expect(readings).not.toHaveBeenCalled();
    expect(r.runLoop).not.toHaveBeenCalled();
  });
});
