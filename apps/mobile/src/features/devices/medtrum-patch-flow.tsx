import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, View } from 'react-native';
import {
  activateMedtrumPatch,
  deactivateMedtrumPatch,
  forceDeactivateMedtrumPatch,
  isMedtrumNanoDriver,
  primeMedtrumPatch,
  readMedtrumPatchStatus,
  refreshMedtrumPatch,
  syncMedtrumPatchTime,
  type MedtrumPatchStatus,
} from '@buddy/devices';
import { currentPump, now, restartRuntime } from '@/runtime/runtime';
import { useSettings } from '@/runtime/settings-store';
import { LinkButton, PrimaryButton, Row, Section, T, useTrioColors, ValueRow } from '@/trio';

const POLL_MS = 3_000;
const PATCH_LIFE_MS = 72 * 3_600_000;

/** Bench note shown on every patch step (replaces MedtrumKit's on-body instructions). */
export const BENCH_NOTE = 'Bench use only: fill the patch with water, never with insulin, and never attach it to a body.';

type Busy = null | 'prime' | 'activate' | 'deactivate' | 'sync' | 'refresh';

const fmtDate = (ms: number) => new Date(ms).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });

/**
 * Medtrum Nano patch lifecycle from MedtrumKit's onboarding and settings:
 * "Fill and Prime the Patch" → "Attach and Activate the Patch" → running → deactivate.
 */
export function MedtrumPatchFlow({ onActivated }: { onActivated?: () => void }) {
  const c = useTrioColors();
  const profile = useSettings((s) => s.profile);
  const [status, setStatus] = useState<MedtrumPatchStatus | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const priming = useRef(false);
  const driver = currentPump();
  const medtrum = driver && isMedtrumNanoDriver(driver) ? driver : null;

  const read = useCallback(async () => {
    if (!medtrum) return null;
    const s = await readMedtrumPatchStatus(medtrum).catch(() => null);
    setStatus(s);
    return s;
  }, [medtrum]);

  useEffect(() => {
    void read();
  }, [read]);

  // While priming, poll the patch until it reports `primed` (MedtrumKit PatchPrimingViewModel).
  useEffect(() => {
    if (!medtrum || status?.patchStateName !== 'priming') return;
    const id = setInterval(() => {
      void refreshMedtrumPatch(medtrum).then(() => read());
    }, POLL_MS);
    return () => clearInterval(id);
  }, [medtrum, status?.patchStateName, read]);

  const run = async (what: Busy, action: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(what);
    setError(null);
    try {
      const r = await action();
      if (!r.ok) setError(r.error ?? 'Unknown error');
      return r.ok;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      await read();
      setBusy(null);
    }
  };

  if (!medtrum) {
    return (
      <Section footer="Select the Medtrum Nano as pump first, then reconnect.">
        <Row>
          <T style={{ flex: 1 }}>Pump base not connected</T>
          <LinkButton label="Reconnect" onPress={() => void restartRuntime().then(() => read())} />
        </Row>
      </Section>
    );
  }

  const state = status?.patchStateName ?? null;
  const phase = status?.phase ?? null;
  const expiresAt = status?.patchActivatedAt ? status.patchActivatedAt + PATCH_LIFE_MS : null;

  return (
    <>
      <Section header="Patch">
        <ValueRow label="State" value={state ?? 'Reading…'} />
        {status ? <ValueRow label="Connected" value={status.connected ? 'Yes' : 'No'} /> : null}
        {status?.reservoirUnits != null ? <ValueRow label="Insulin Remaining" value={`${status.reservoirUnits.toFixed(1)} U`} /> : null}
        {status?.batteryVolts != null ? <ValueRow label="Battery" value={`${status.batteryVolts.toFixed(2)} V`} /> : null}
        {status?.patchActivatedAt ? <ValueRow label="Activated" value={fmtDate(status.patchActivatedAt)} /> : null}
        {expiresAt ? <ValueRow label="Expires" value={fmtDate(expiresAt)} valueColor={expiresAt < now() ? c.red : undefined} /> : null}
        {status ? <ValueRow label="Model" value={`${status.model} · ${status.swVersion}`} /> : null}
      </Section>

      {phase === 'setup' && state !== 'primed' ? (
        <Section header="Fill and Prime the Patch" footer={BENCH_NOTE}>
          <Row>
            <T style={{ flex: 1 }}>
              Connect your pump base to a new patch and fill the patch with water. Then press the needle button and start priming.
            </T>
          </Row>
          {state === 'priming' ? (
            <Row>
              <ActivityIndicator />
              <T style={{ flex: 1 }}>Priming… {status?.primeProgress ?? 0}</T>
            </Row>
          ) : null}
        </Section>
      ) : null}

      {phase === 'setup' && state === 'primed' ? (
        <Section header="Activate the Patch" footer={BENCH_NOTE}>
          <Row>
            <T style={{ flex: 1 }}>Priming is complete. Remove the safety lock and press the needle button. Then activate the patch. It starts delivering your basal schedule.</T>
          </Row>
        </Section>
      ) : null}

      {error ? (
        <T color={c.red} style={{ marginHorizontal: 20 }}>
          {error}
        </T>
      ) : null}

      {phase === 'setup' && state !== 'primed' && state !== 'priming' ? (
        <PrimaryButton
          label="Start priming"
          loading={busy === 'prime'}
          onPress={() => {
            if (priming.current) return;
            priming.current = true;
            void run('prime', () => primeMedtrumPatch(medtrum)).finally(() => (priming.current = false));
          }}
        />
      ) : null}
      {phase === 'setup' && state === 'primed' ? (
        <PrimaryButton
          label="Activate Patch"
          loading={busy === 'activate'}
          onPress={() => void run('activate', () => activateMedtrumPatch(medtrum, profile.basal)).then((ok) => ok && onActivated?.())}
        />
      ) : null}

      <Section>
        <Row onPress={() => void run('refresh', () => refreshMedtrumPatch(medtrum))}>
          <T color={c.tabBar} style={{ flex: 1 }}>
            Refresh
          </T>
          {busy === 'refresh' ? <ActivityIndicator /> : null}
        </Row>
        {phase === 'running' ? (
          <Row onPress={() => void run('sync', () => syncMedtrumPatchTime(medtrum))}>
            <T color={c.tabBar} style={{ flex: 1 }}>
              Sync to Current Time
            </T>
            {busy === 'sync' ? <ActivityIndicator /> : null}
          </Row>
        ) : null}
      </Section>

      {phase === 'running' || state === 'primed' || state === 'priming' ? (
        <View>
          <PrimaryButton
            label="Deactivate Patch"
            color={c.red}
            loading={busy === 'deactivate'}
            onPress={() =>
              Alert.alert('Deactivate Patch', 'Stops delivery permanently. The patch cannot be reused.', [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Deactivate',
                  style: 'destructive',
                  onPress: () =>
                    void run('deactivate', () => deactivateMedtrumPatch(medtrum)).then((ok) => {
                      if (ok) return;
                      Alert.alert('Patch unreachable', 'Forget the patch without reaching it? Remove it from the pump base afterwards.', [
                        { text: 'Cancel', style: 'cancel' },
                        { text: 'Force Deactivate', style: 'destructive', onPress: () => void run('deactivate', () => forceDeactivateMedtrumPatch(medtrum)) },
                      ]);
                    }),
                },
              ])
            }
          />
        </View>
      ) : null}
    </>
  );
}
