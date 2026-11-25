import { useRef, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { HOUR, MINUTE, scheduleValueAt, type PumpDriver, type PumpState } from '@buddy/core';
import { currentPump, deliverBolus, now, refreshEligibility, setPumpSuspended, store, useRuntime } from '@/runtime/runtime';
import { useSettings } from '@/runtime/settings-store';
import { CheckboxRow, PrimaryButton, Row, Section, T, useTrioColors, ValueRow } from '@/trio';
import { bolusMatches, deliveredBolusSince, HARDWARE_STEPS, linkDropBolus, testTempBasalRate, type HardwareStepId } from './hardware-check-logic';

const TEMP_MINUTES = 30;
const TEST_BOLUS = 0.1;
/** Pump and phone clocks may differ slightly; history is read from a little earlier. */
const HISTORY_SLACK = MINUTE;

interface Phase {
  /** Performs the pump command; returns lines describing what Buddy sees. */
  readonly run: () => Promise<string[]>;
  readonly question: string;
  /** Label of the button that runs the phase. */
  readonly action: string;
}

const PRECONDITIONS = [
  'The pump is not attached to a body.',
  'The reservoir holds water only, never insulin.',
  'I can see the pump display and its history.',
] as const;

const fmtU = (u: number) => `${u.toFixed(2)} U`;

function describe(s: PumpState): string[] {
  return [
    `Reservoir: ${s.reservoirUnits == null ? 'unknown' : fmtU(s.reservoirUnits)}`,
    `Battery: ${s.batteryPercent == null ? 'unknown' : `${Math.round(s.batteryPercent)} %`}`,
    `Delivery: ${s.suspended ? 'suspended' : s.tempBasal ? `temp basal ${s.tempBasal.rate} U/h` : 'scheduled basal'}`,
  ];
}

async function syncHistory(pump: PumpDriver) {
  store.addDoses(await pump.history(now() - HOUR));
  useRuntime.setState({ pump: await pump.status() });
}

function buildPhases(pump: PumpDriver, id: HardwareStepId, ctx: { rate: number; linkDropUnits: number; linkDropSince: { current: number }; linkDropBefore: { current: number } }): Phase[] {
  const bolusPhase = (units: number, label: string, question: (u: string) => string): Phase => ({
    action: label,
    question: question(fmtU(units)),
    run: async () => {
      const since = now() - HISTORY_SLACK;
      // Earlier boluses inside the slack window are subtracted.
      const before = deliveredBolusSince(await pump.history(since), since);
      let commandError: string | null = null;
      await deliverBolus(units).catch((e: unknown) => (commandError = e instanceof Error ? e.message : String(e)));
      const reported = Math.round((deliveredBolusSince(await pump.history(since), since) - before) * 1000) / 1000;
      const inc = (await pump.status()).bolusIncrement;
      return [
        ...(commandError ? [`Command result: ${commandError}`] : []),
        `Buddy reports delivered: ${fmtU(reported)}`,
        bolusMatches(reported, units, inc) ? `Matches the requested ${fmtU(units)}.` : `Differs from the requested ${fmtU(units)}.`,
      ];
    },
  });

  switch (id) {
    case 'status':
      return [{ action: 'Read Status', question: 'Do all values match the pump display?', run: async () => describe(await pump.status()) }];
    case 'tempBasal':
      return [
        {
          action: `Set ${ctx.rate} U/h for ${TEMP_MINUTES} min`,
          question: `Does the pump display show a temporary basal of ${ctx.rate} U/h?`,
          run: async () => {
            const r = await pump.setTempBasal(ctx.rate, TEMP_MINUTES);
            if (!r.ok) throw new Error(r.error);
            await syncHistory(pump);
            return describe(await pump.status());
          },
        },
        {
          action: 'Cancel Temporary Basal',
          question: 'Is the temporary basal cancelled on the pump display?',
          run: async () => {
            const r = await pump.cancelTempBasal();
            if (!r.ok) throw new Error(r.error);
            await syncHistory(pump);
            return describe(await pump.status());
          },
        },
      ];
    case 'bolus':
      return [bolusPhase(TEST_BOLUS, `Deliver ${fmtU(TEST_BOLUS)}`, (u) => `Does the pump history show a bolus of ${u}, the same as Buddy reports?`)];
    case 'suspend':
      return [
        {
          action: 'Suspend Insulin Delivery',
          question: 'Does the pump display show delivery suspended?',
          run: async () => {
            await setPumpSuspended(true);
            return describe(await pump.status());
          },
        },
        {
          action: 'Resume Insulin Delivery',
          question: 'Does the pump display show delivery running again?',
          run: async () => {
            await setPumpSuspended(false);
            return describe(await pump.status());
          },
        },
      ];
    case 'linkDrop':
      return [
        {
          action: `Start ${fmtU(ctx.linkDropUnits)} Bolus`,
          question: 'Turn Bluetooth on again and wait until the pump finished or stopped the bolus. Done?',
          run: async () => {
            const since = now() - HISTORY_SLACK;
            ctx.linkDropSince.current = since;
            ctx.linkDropBefore.current = deliveredBolusSince(await pump.history(since), since);
            const error = await deliverBolus(ctx.linkDropUnits).then(
              () => null,
              (e: unknown) => (e instanceof Error ? e.message : String(e)),
            );
            return [error ? `Command result: ${error}` : 'Command result: confirmed by the pump'];
          },
        },
        {
          action: 'Read Pump History',
          question: 'Does Buddy report exactly the amount the pump history shows for this bolus (complete or interrupted)?',
          run: async () => {
            const since = ctx.linkDropSince.current;
            const reported = Math.round((deliveredBolusSince(await pump.history(since), since) - ctx.linkDropBefore.current) * 1000) / 1000;
            await syncHistory(pump);
            return [`Buddy reports delivered: ${fmtU(reported)}`];
          },
        },
      ];
  }
}

/**
 * Hardware check for experimental drivers (`meta.requiresHardwareCheck`). Runs on the bench with a
 * pump that is not worn; every pump command is confirmed by the user against the pump display.
 * Success unlocks closed loop for this pump (the runtime enforces it).
 */
export function HardwareCheck({ pumpId, onDone }: { pumpId: string; onDone?: () => void }) {
  const c = useTrioColors();
  const s = useSettings();
  const activePump = useSettings((x) => x.pumpId);
  const completed = s.hardwareChecks[pumpId];
  const [ticks, setTicks] = useState<boolean[]>(PRECONDITIONS.map(() => false));
  const [stepIndex, setStepIndex] = useState<number | null>(null);
  const [phaseIndex, setPhaseIndex] = useState(0);
  const [lines, setLines] = useState<string[] | null>(null);
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const linkDropSince = useRef(0);
  const linkDropBefore = useRef(0);

  const pump = currentPump();
  const ready = pump && pump.meta.id === pumpId && activePump === pumpId;
  if (!ready) {
    return (
      <Section footer="Set up this pump and connect it first.">
        <ValueRow label="Hardware Check" value={completed ? 'Completed' : 'Required'} />
      </Section>
    );
  }

  const scheduled = scheduleValueAt(s.profile.basal, now(), s.profile.utcOffsetMinutes);
  const basalIncrement = useRuntime.getState().pump?.basalIncrement ?? 0.05;
  const bolusIncrement = useRuntime.getState().pump?.bolusIncrement ?? 0.05;
  const ctx = { rate: testTempBasalRate(scheduled, s.limits.maxBasalRate, basalIncrement), linkDropUnits: linkDropBolus(s.limits.maxBolus, bolusIncrement), linkDropSince, linkDropBefore };
  const step = stepIndex === null ? null : HARDWARE_STEPS[stepIndex]!;
  const phases = step ? buildPhases(pump, step.id, ctx) : [];
  const phase = phases[phaseIndex];

  const runPhase = async () => {
    if (!phase) return;
    setRunning(true);
    setFailure(null);
    try {
      setLines(await phase.run());
    } catch (e) {
      setLines(null);
      setFailure(`${step!.title}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRunning(false);
    }
  };

  const confirm = (yes: boolean) => {
    if (!yes) {
      setFailure(`${step!.title} did not match the pump. Closed loop stays disabled for this driver.`);
      setStepIndex(null);
      setLines(null);
      return;
    }
    setLines(null);
    if (phaseIndex + 1 < phases.length) return setPhaseIndex(phaseIndex + 1);
    setPhaseIndex(0);
    if (stepIndex! + 1 < HARDWARE_STEPS.length) return setStepIndex(stepIndex! + 1);
    s.update({ hardwareChecks: { ...s.hardwareChecks, [pumpId]: now() } });
    refreshEligibility();
    setStepIndex(null);
    onDone?.();
  };

  return (
    <>
      <Section
        header="Hardware Check"
        footer={`${pump.meta.name} is an experimental driver. Closed loop stays disabled until every step below matched the pump.`}>
        <ValueRow label="Status" value={completed ? `Completed ${new Date(completed).toLocaleDateString()}` : 'Required'} valueColor={completed ? c.green : c.orange} />
      </Section>

      {stepIndex === null ? (
        <>
          <Section header="Before You Start">
            {PRECONDITIONS.map((p, i) => (
              <CheckboxRow key={p} label={p} value={ticks[i]!} onChange={(v) => setTicks(ticks.map((t, j) => (j === i ? v : t)))} />
            ))}
          </Section>
          <Section header="Steps">
            {HARDWARE_STEPS.map((h, i) => (
              <Row key={h.id}>
                <T secondary style={{ width: 20 }}>
                  {i + 1}
                </T>
                <View style={{ flex: 1 }}>
                  <T>{h.title}</T>
                  <T style_="footnote" secondary>
                    {h.instruction}
                  </T>
                </View>
              </Row>
            ))}
          </Section>
          {failure ? <T color={c.red} style={{ marginHorizontal: 20 }}>{failure}</T> : null}
          <PrimaryButton
            label={completed ? 'Run Hardware Check Again' : 'Start Hardware Check'}
            disabled={!ticks.every(Boolean)}
            onPress={() => {
              setFailure(null);
              setPhaseIndex(0);
              setStepIndex(0);
            }}
          />
        </>
      ) : (
        <>
          <Section header={`Step ${stepIndex + 1} of ${HARDWARE_STEPS.length}: ${step!.title}`} footer={step!.instruction}>
            {(lines ?? []).map((l) => (
              <Row key={l}>
                <T>{l}</T>
              </Row>
            ))}
            {running ? (
              <Row>
                <ActivityIndicator />
                <T secondary>Waiting for the pump…</T>
              </Row>
            ) : null}
            {!lines && !running ? (
              <Row>
                <T secondary>{phase!.action}</T>
              </Row>
            ) : null}
          </Section>
          {failure ? <T color={c.red} style={{ marginHorizontal: 20 }}>{failure}</T> : null}
          {lines ? (
            <>
              <T style_="headline" style={{ marginHorizontal: 20 }}>
                {phase!.question}
              </T>
              <PrimaryButton label="Yes, It Matches" onPress={() => confirm(true)} />
              <PrimaryButton label="No" color={c.red} onPress={() => confirm(false)} />
            </>
          ) : (
            <PrimaryButton label={phase!.action} loading={running} onPress={() => void runPhase()} />
          )}
          {!running ? (
            <PrimaryButton
              label="Stop Hardware Check"
              color={c.fill}
              onPress={() => {
                setStepIndex(null);
                setLines(null);
              }}
            />
          ) : null}
        </>
      )}
    </>
  );
}
