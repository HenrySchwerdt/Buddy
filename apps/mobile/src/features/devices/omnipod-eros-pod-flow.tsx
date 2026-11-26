// Eros pod lifecycle screen for the TypeScript port of OmnipodKit (MIT License, (c) LoopKit Authors).
import { useCallback, useEffect, useRef, useState } from 'react';
import { POD_BENCH_NOTE } from './omnipod-pod-flow';
import { ActivityIndicator, Alert, View } from 'react-native';
import {
  deactivateErosPod,
  discardErosPod,
  insertErosCannula,
  isOmnipodErosDriver,
  pairAndPrimeErosPod,
  readErosPodStatus,
  refreshErosPod,
  type OmnipodPodStatus,
} from '@buddy/devices';
import { currentPump, now, restartRuntime } from '@/runtime/runtime';
import { useSettings } from '@/runtime/settings-store';
import { LinkButton, PrimaryButton, Row, Section, T, useTrioColors, ValueRow } from '@/trio';


const POLL_MS = 3_000;

type Busy = null | 'pair' | 'insert' | 'deactivate' | 'refresh';

const fmtDate = (ms: number) => new Date(ms).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
const fmtReservoir = (s: OmnipodPodStatus) => (s.reservoirUnits != null ? `${s.reservoirUnits.toFixed(1)} U` : s.reservoirAbove50 ? 'More than 50 U' : null);

const PHASE_LABEL: Record<OmnipodPodStatus['phase'], string> = {
  none: 'No pod',
  pairing: 'Pairing',
  priming: 'Priming',
  readyToInsert: 'Ready for cannula insertion',
  inserting: 'Inserting cannula',
  running: 'Running',
  faulted: 'Fault',
};

/**
 * Omnipod Eros pod lifecycle from OmnipodKit's onboarding and settings:
 * "Fill Pod" → "Pair and Prime" → "Insert Cannula" → running → deactivate.
 * Bench only: the pod holds water and stays on the bench.
 */
export function OmnipodErosPodFlow({ onActivated }: { onActivated?: () => void }) {
  const c = useTrioColors();
  const profile = useSettings((s) => s.profile);
  const [status, setStatus] = useState<OmnipodPodStatus | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const inFlight = useRef(false);
  const lastPhase = useRef<OmnipodPodStatus['phase'] | null>(null);
  const driver = currentPump();
  const pod = driver && isOmnipodErosDriver(driver) ? driver : null;

  const read = useCallback(async () => {
    if (!pod) return null;
    const s = await readErosPodStatus(pod).catch(() => null);
    setStatus(s);
    return s;
  }, [pod]);

  useEffect(() => {
    void read();
  }, [read]);

  // Tell the caller once the pod finished its setup (the phase changed to running while we watched).
  useEffect(() => {
    if (status && lastPhase.current && lastPhase.current !== 'running' && status.phase === 'running') onActivated?.();
    lastPhase.current = status?.phase ?? null;
  }, [status, onActivated]);

  // While the pod primes or inserts its cannula, poll it until it reports the next step.
  const phase = status?.phase ?? null;
  const polling = phase === 'priming' || phase === 'inserting' || phase === 'readyToInsert';
  useEffect(() => {
    if (!pod || !polling) return;
    const id = setInterval(() => {
      setTick((t) => t + 1);
      if (inFlight.current) return;
      inFlight.current = true;
      void refreshErosPod(pod)
        .then(() => read())
        .finally(() => (inFlight.current = false));
    }, POLL_MS);
    return () => clearInterval(id);
  }, [pod, polling, read]);

  const run = async (what: Busy, action: () => Promise<{ ok: boolean; error?: string }>) => {
    if (inFlight.current) return false;
    inFlight.current = true;
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
      inFlight.current = false;
    }
  };

  if (!pod) {
    return (
      <Section footer="Select the Omnipod (Eros) as pump first, then reconnect.">
        <Row>
          <T style={{ flex: 1 }}>Pod not connected</T>
          <LinkButton label="Reconnect" onPress={() => void restartRuntime().then(() => read())} />
        </Row>
      </Section>
    );
  }

  const primeLeft = status?.primeFinishAt ? Math.max(0, Math.ceil((status.primeFinishAt - now()) / 1000)) : 0;
  const primed = status?.podProgressName === 'primingCompleted' || status?.podProgressName === 'basalInitialized';
  const reservoir = status ? fmtReservoir(status) : null;
  void tick; // re-render while polling so the priming countdown moves

  return (
    <>
      <Section header="Pod">
        <ValueRow label="State" value={status ? PHASE_LABEL[status.phase] : 'Reading…'} />
        {status ? <ValueRow label="Connected" value={status.connected ? 'Yes' : 'No'} /> : null}
        {status && status.podProgressName !== 'none' ? <ValueRow label="Pod Progress" value={status.podProgressName} /> : null}
        {reservoir ? <ValueRow label="Insulin Remaining" value={reservoir} /> : null}
        {status?.activatedAt ? <ValueRow label="Activated" value={fmtDate(status.activatedAt)} /> : null}
        {status?.expiresAt ? <ValueRow label="Expires" value={fmtDate(status.expiresAt)} valueColor={status.expiresAt < now() ? c.red : undefined} /> : null}
        {status?.firmwareVersion ? <ValueRow label="Firmware" value={status.firmwareVersion} /> : null}
        {status?.fault ? <ValueRow label="Fault" value={status.fault} valueColor={c.red} /> : null}
      </Section>

      {phase === 'none' || phase === 'pairing' ? (
        <Section header="Fill and Pair the Pod" footer={POD_BENCH_NOTE}>
          <Row>
            <T style={{ flex: 1 }}>Fill a new pod with water and wait for its beeps. Keep it close to the RileyLink, then pair it. The pod primes right after pairing.</T>
          </Row>
        </Section>
      ) : null}

      {phase === 'priming' ? (
        <Section header="Priming" footer={POD_BENCH_NOTE}>
          <Row>
            <ActivityIndicator />
            <T style={{ flex: 1 }}>{primed ? 'Priming is complete.' : primeLeft > 0 ? `Priming… about ${primeLeft} s left` : 'Waiting for the pod to finish priming…'}</T>
          </Row>
        </Section>
      ) : null}

      {phase === 'readyToInsert' || phase === 'inserting' ? (
        <Section header="Cannula Insertion" footer={POD_BENCH_NOTE}>
          <Row>
            <ActivityIndicator />
            <T style={{ flex: 1 }}>The pod is running its cannula insertion on the bench. This takes about half a minute.</T>
          </Row>
        </Section>
      ) : null}

      {phase === 'faulted' ? (
        <Section header="Pod Fault" footer={POD_BENCH_NOTE}>
          <Row>
            <T color={c.red} style={{ flex: 1 }}>
              The pod stopped delivering ({status?.fault ?? 'fault'}). Deactivate it, or discard it if it cannot be reached.
            </T>
          </Row>
        </Section>
      ) : null}

      {error ? (
        <T color={c.red} style={{ marginHorizontal: 20 }}>
          {error}
        </T>
      ) : null}

      {phase === 'none' || phase === 'pairing' ? <PrimaryButton label="Pair and Prime Pod" loading={busy === 'pair'} onPress={() => void run('pair', () => pairAndPrimeErosPod(pod))} /> : null}
      {phase === 'priming' && primed ? (
        <PrimaryButton label="Insert Cannula (Bench)" loading={busy === 'insert'} onPress={() => void run('insert', () => insertErosCannula(pod, profile.basal))} />
      ) : null}

      {phase !== 'none' ? (
        <Section>
          <Row onPress={() => void run('refresh', () => refreshErosPod(pod))}>
            <T color={c.tabBar} style={{ flex: 1 }}>
              Refresh
            </T>
            {busy === 'refresh' ? <ActivityIndicator /> : null}
          </Row>
        </Section>
      ) : null}

      {phase && phase !== 'none' ? (
        <View>
          <PrimaryButton
            label="Deactivate Pod"
            color={c.red}
            loading={busy === 'deactivate'}
            onPress={() =>
              Alert.alert('Deactivate Pod', 'Stops delivery permanently. The pod cannot be reused.', [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Deactivate',
                  style: 'destructive',
                  onPress: () =>
                    void run('deactivate', () => deactivateErosPod(pod)).then((ok) => {
                      if (ok) return;
                      Alert.alert('Pod unreachable', 'Forget the pod without reaching it? It keeps running until it expires.', [
                        { text: 'Cancel', style: 'cancel' },
                        { text: 'Discard Pod', style: 'destructive', onPress: () => void run('deactivate', () => discardErosPod(pod)) },
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
