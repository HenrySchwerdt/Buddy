// Accu-Chek Insight onboarding: a port of the setup flow of InsightKitUI (Buddy owner's Swift driver):
// intro -> find the InsightBridge -> pair (same 6-digit code on both phones) -> check the pump -> sync clock and basal profile.
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, View } from 'react-native';
import { silentLogger, systemClock, type PumpPlugin, type SettingsValues } from '@buddy/core';
import {
  deleteCredentials,
  isInsightDriver,
  pairInsightBridge,
  scanInsightBridges,
  simplifyBasalSchedule,
  type BridgeStatus,
  type DiscoveredBridge,
  type InsightPairing,
  type PairingResult,
} from '@buddy/devices';
import { currentPump } from '@/runtime/runtime';
import { useSettings } from '@/runtime/settings-store';
import { bleTransport } from '@/runtime/transports/ble';
import { keychainSecretStore } from '@/runtime/transports/secret-store';
import { LinkButton, PrimaryButton, Row, Section, T, useTrioColors } from '@/trio';
import type { CatalogEntry } from './catalog';
import { activateDevice, errorText, useDeviceValues } from './device-actions';
import { DeviceIcon } from './device-icon';
import { TextRow } from './setup-rows';

const TOTAL_STEPS = 5;
const SCAN_MS = 60_000;
/** Show the troubleshooting list when no bridge showed up after this long. */
const HINT_AFTER_MS = 12_000;
const BRIDGE_URL = 'https://github.com/HenrySchwerdt/InsightBridge';
const EXPERIMENTAL_NOTE = 'Experimental: this driver has never been verified on a real pump by Buddy. Use it on the bench with a pump that is not worn.';

type Step = 'intro' | 'scan' | 'pair' | 'check' | 'finish';

type Phase =
  | { readonly kind: 'connecting' }
  | { readonly kind: 'confirmCode'; readonly code: string }
  | { readonly kind: 'waitingForBridge' }
  | { readonly kind: 'failed'; readonly message: string; readonly hint: readonly string[] };

const stepHeader = (n: number) => `Step ${n} of ${TOTAL_STEPS}`;

/** What to do next after a failed pairing (InsightKitUI failure pages). */
function pairingHint(kind: string, detail: string): readonly string[] {
  if (kind === 'pairingRejected' && detail === 'notInPairingMode') return ['Open InsightBridge on the Android phone.', 'Tap "Pair with iPhone" and then try again within two minutes.'];
  if (kind === 'pairingRejected') return ['Pairing was cancelled on one of the phones.', 'Start again; both phones must show the same code.'];
  if (kind === 'timeout') return ['Is InsightBridge open and in range?', 'Tap "Pair with iPhone" in the bridge app, then try again.'];
  if (kind === 'bluetoothUnavailable') return ['Turn Bluetooth on and allow Buddy to use it.'];
  return ['Keep both phones close together and try again.'];
}

const bridgeError = (e: unknown): { kind: string; detail: string; message: string } => {
  const o = e as { kind?: unknown; detail?: unknown } | null;
  return { kind: typeof o?.kind === 'string' ? o.kind : 'other', detail: typeof o?.detail === 'string' ? o.detail : '', message: errorText(e) };
};

/** Setup flow. `onConnected` is called once the pump was read and the clock and basal profile are on it. */
export function InsightSetup({ plugin, entry, onConnected }: { plugin: PumpPlugin; entry: CatalogEntry; onConnected: () => void }) {
  const { values } = useDeviceValues(plugin);
  const [step, setStep] = useState<Step>('intro');
  const [bridge, setBridge] = useState<DiscoveredBridge | null>(null);
  const [paired, setPaired] = useState<PairingResult | null>(null);
  const activated = useRef(false);
  const pairedRef = useRef<PairingResult | null>(null);
  pairedRef.current = paired;

  // Leaving the setup before it finished must not leave a pairing key behind (InsightKit `cancelSetup`).
  useEffect(
    () => () => {
      const p = pairedRef.current;
      if (p && !activated.current) void deleteCredentials(keychainSecretStore, p.bridgeId).catch(() => undefined);
    },
    [],
  );

  switch (step) {
    case 'intro':
      return <IntroStep entry={entry} next={() => setStep('scan')} />;
    case 'scan':
      return (
        <ScanStep
          select={(d) => {
            setBridge(d);
            setStep('pair');
          }}
        />
      );
    case 'pair':
      return (
        <PairStep
          device={bridge!}
          back={() => setStep('scan')}
          done={(r) => {
            setPaired(r);
            setStep('check');
          }}
        />
      );
    case 'check':
      return (
        <CheckStep
          plugin={plugin}
          entry={entry}
          values={values}
          paired={paired!}
          onActivated={() => {
            activated.current = true;
          }}
          back={() => setStep('scan')}
          next={() => setStep('finish')}
        />
      );
    case 'finish':
      return <FinishStep onConnected={onConnected} />;
  }
}

function IntroStep({ entry, next }: { entry: CatalogEntry; next: () => void }) {
  return (
    <>
      <Section header={stepHeader(1)} footer={EXPERIMENTAL_NOTE}>
        <View style={{ alignItems: 'center', paddingVertical: 16 }}>
          <DeviceIcon entry={entry} size={110} background="transparent" />
        </View>
        <TextRow>The Insight pump cannot talk to a phone directly. Buddy controls it through a small Android helper app called InsightBridge that stays connected to the pump.</TextRow>
      </Section>
      <Section header="Before you start">
        <TextRow>An Android phone with InsightBridge: install and open the app on an Android phone that stays near you.</TextRow>
        <TextRow>The pump is already paired in InsightBridge: pair your Insight pump in the InsightBridge app first. Buddy only talks to the bridge.</TextRow>
        <TextRow>Bluetooth is on: it must be on for both phones. Keep them close during setup.</TextRow>
        <Row onPress={() => void Linking.openURL(BRIDGE_URL)} accessibilityLabel="Get InsightBridge and read the instructions">
          <T style={{ flex: 1 }}>Get InsightBridge and read the instructions</T>
        </Row>
      </Section>
      <PrimaryButton label="I'm ready" onPress={next} />
    </>
  );
}

function ScanStep({ select }: { select: (d: DiscoveredBridge) => void }) {
  const c = useTrioColors();
  const [devices, setDevices] = useState<readonly DiscoveredBridge[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(true);
  const [hint, setHint] = useState(false);
  const [run, setRun] = useState(0);

  useEffect(() => {
    let active = true;
    setScanning(true);
    setError(null);
    setDevices([]);
    setHint(false);
    const timer = setTimeout(() => active && setHint(true), HINT_AFTER_MS);
    scanInsightBridges(bleTransport, { timeoutMs: SCAN_MS, onUpdate: (d) => active && setDevices(d) })
      .catch((e: unknown) => active && setError(errorText(e)))
      .finally(() => active && setScanning(false));
    return () => {
      active = false;
      clearTimeout(timer);
      bleTransport.stopScan();
    };
  }, [run]);

  return (
    <>
      <Section header={stepHeader(2)}>
        <TextRow>Open InsightBridge on the Android phone, then tap your bridge below.</TextRow>
        {error ? (
          <Row>
            <T color={c.red} style={{ flex: 1 }}>
              {error}
            </T>
          </Row>
        ) : null}
      </Section>
      <Section header={devices.length === 0 ? 'Scanning' : 'Bridges found'}>
        {devices.map((d) => (
          <Row key={d.id} onPress={() => select(d)} accessibilityLabel={d.name}>
            <T style={{ flex: 1 }}>{d.name}</T>
          </Row>
        ))}
        {devices.length === 0 ? (
          <Row>
            {scanning ? <ActivityIndicator /> : null}
            <T secondary style={{ flex: 1 }}>
              {scanning ? 'Searching for InsightBridge…' : 'No bridge found.'}
            </T>
          </Row>
        ) : null}
      </Section>
      {hint && devices.length === 0 ? (
        <Section header="Bridge not found?">
          <TextRow>Is the InsightBridge app open on the Android phone? It only advertises while it is running.</TextRow>
          <TextRow>Is Bluetooth turned on on both phones?</TextRow>
          <TextRow>Move the phones closer together.</TextRow>
          <TextRow>Make sure Buddy is allowed to use Bluetooth in the system settings.</TextRow>
        </Section>
      ) : null}
      {!scanning ? <PrimaryButton label="Scan Again" onPress={() => setRun((n) => n + 1)} /> : null}
    </>
  );
}

function PairStep({ device, back, done }: { device: DiscoveredBridge; back: () => void; done: (r: PairingResult) => void }) {
  const c = useTrioColors();
  const [phase, setPhase] = useState<Phase>({ kind: 'connecting' });
  const [attempt, setAttempt] = useState(0);
  const pairing = useRef<InsightPairing | null>(null);

  useEffect(() => {
    let active = true;
    setPhase({ kind: 'connecting' });
    const p = pairInsightBridge({
      ble: bleTransport,
      clock: systemClock,
      log: silentLogger,
      peripheralId: device.id,
      name: device.name,
      secrets: keychainSecretStore,
      onEvent: (e) => {
        if (!active) return;
        if (e.kind === 'confirmCode') setPhase({ kind: 'confirmCode', code: e.code });
        else if (e.kind === 'waitingForBridgeConfirmation') setPhase({ kind: 'waitingForBridge' });
        else if (e.kind === 'failed') {
          const { kind, detail, message } = bridgeError(e.error);
          setPhase({ kind: 'failed', message, hint: pairingHint(kind, detail) });
        }
      },
    });
    pairing.current = p;
    p.done.then(
      (r) => active && done(r),
      () => undefined, // reported through the failed event
    );
    return () => {
      active = false;
      p.cancel();
    };
    // `done` changes identity every render; the pairing must start exactly once per attempt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device.id, attempt]);

  if (phase.kind === 'failed') {
    return (
      <>
        <Section header={stepHeader(3)}>
          <Row>
            <T color={c.red} style={{ flex: 1 }}>
              {phase.message}
            </T>
          </Row>
        </Section>
        <Section header="What to do">
          {phase.hint.map((h) => (
            <TextRow key={h}>{h}</TextRow>
          ))}
        </Section>
        <PrimaryButton label="Try again" onPress={() => setAttempt((n) => n + 1)} />
        <PrimaryButton label="Back" color={c.fill} onPress={back} />
      </>
    );
  }
  if (phase.kind === 'confirmCode') {
    return (
      <>
        <Section header={stepHeader(3)}>
          <TextRow>Is this the same code as in InsightBridge?</TextRow>
          <View style={{ alignItems: 'center', paddingVertical: 12 }}>
            <T style_="largeTitle" accessibilityLabel={phase.code.split('').join(' ')}>
              {phase.code}
            </T>
          </View>
          <TextRow secondary>Only confirm if both phones show exactly the same six digits.</TextRow>
        </Section>
        <PrimaryButton label="Codes match" onPress={() => pairing.current?.confirmCode(true)} />
        <PrimaryButton label="Cancel" color={c.fill} onPress={() => pairing.current?.confirmCode(false)} />
      </>
    );
  }
  return (
    <>
      <Section header={stepHeader(3)}>
        <Row>
          <ActivityIndicator />
          <T secondary style={{ flex: 1 }}>
            {phase.kind === 'waitingForBridge' ? 'Waiting for InsightBridge…' : `Connecting to ${device.name}…`}
          </T>
        </Row>
      </Section>
      <Section header="On the Android phone">
        <TextRow>{phase.kind === 'waitingForBridge' ? 'Now confirm the code on the Android phone.' : 'In InsightBridge tap "Pair with iPhone". The bridge only accepts pairing for two minutes.'}</TextRow>
      </Section>
      <PrimaryButton label="Cancel" color={c.fill} onPress={back} />
    </>
  );
}

type CheckPhase = { readonly kind: 'working' } | { readonly kind: 'ok'; readonly status: BridgeStatus } | { readonly kind: 'failed'; readonly message: string; readonly noPump: boolean };

/** Saves the device (with the pairing key as a secret setting) and reads the pump through the bridge. */
function CheckStep({
  plugin,
  entry,
  values,
  paired,
  onActivated,
  back,
  next,
}: {
  plugin: PumpPlugin;
  entry: CatalogEntry;
  values: SettingsValues;
  paired: PairingResult;
  onActivated: () => void;
  back: () => void;
  next: () => void;
}) {
  const c = useTrioColors();
  const profile = useSettings((s) => s.profile);
  const limits = useSettings((s) => s.limits);
  const [phase, setPhase] = useState<CheckPhase>({ kind: 'working' });
  const [run, setRun] = useState(0);

  useEffect(() => {
    let active = true;
    setPhase({ kind: 'working' });
    (async () => {
      let basalProfile = '';
      try {
        basalProfile = simplifyBasalSchedule(profile.basal).rates.join(', ');
      } catch {
        // Reported in the next step: the profile cannot be written, so temp basals stay refused.
      }
      await activateDevice(
        'pump',
        plugin,
        {
          ...values,
          bridgeId: paired.bridgeId,
          bridgeName: paired.bridgeName,
          bridgePeripheral: paired.peripheralId,
          pairingSecret: paired.pairingSecret,
          basalProfile,
          maxBolus: Math.min(limits.maxBolus, 25),
          maxBasal: Math.min(limits.maxBasalRate, 25),
        },
        entry.id,
      );
      onActivated();
      const pump = currentPump();
      if (!isInsightDriver(pump)) throw new Error('The Insight driver is not active.');
      const status = await pump.checkPump();
      if (active) setPhase({ kind: 'ok', status });
    })().catch((e: unknown) => {
      if (active) setPhase({ kind: 'failed', message: errorText(e), noPump: /no insight pump paired/i.test(errorText(e)) });
    });
    return () => {
      active = false;
    };
    // Re-runs only when the user taps "Try again".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run]);

  if (phase.kind === 'working') {
    return (
      <Section header={stepHeader(4)}>
        <Row>
          <ActivityIndicator />
          <T secondary style={{ flex: 1 }}>
            Reading the pump through the bridge…
          </T>
        </Row>
      </Section>
    );
  }
  if (phase.kind === 'failed') {
    return (
      <>
        <Section header={phase.noPump ? 'The bridge has no pump' : 'Check the connection'}>
          <Row>
            <T color={c.red} style={{ flex: 1 }}>
              {phase.message}
            </T>
          </Row>
          {phase.noPump ? (
            <>
              <TextRow>Open InsightBridge and pair your Insight pump there first.</TextRow>
              <TextRow>Then come back and tap Try again.</TextRow>
            </>
          ) : (
            <>
              <TextRow>InsightBridge must be running and connected to the pump.</TextRow>
              <TextRow>Keep the Android phone close to the pump and to this phone.</TextRow>
            </>
          )}
        </Section>
        <PrimaryButton label="Try again" onPress={() => setRun((n) => n + 1)} />
        <PrimaryButton label="Back" color={c.fill} onPress={back} />
      </>
    );
  }
  const s = phase.status;
  return (
    <>
      <Section header={stepHeader(4)}>
        <SummaryRow label="Serial number" value={s.serial ?? '–'} />
        <SummaryRow label="Firmware" value={s.firmware ?? '–'} />
        <SummaryRow label="Insulin in reservoir" value={s.reservoirUnits === null ? '–' : `${s.reservoirUnits.toFixed(1)} U`} />
        <SummaryRow label="Battery" value={s.batteryPercent === null ? '–' : `${Math.round(s.batteryPercent)} %`} />
        {s.serial === 'SIMULATOR' ? <TextRow secondary>This is the bridge's simulated pump.</TextRow> : null}
      </Section>
      <PrimaryButton label="Continue" onPress={next} />
    </>
  );
}

const SummaryRow = ({ label, value }: { label: string; value: string }) => (
  <Row>
    <T style={{ flex: 1 }}>{label}</T>
    <T secondary>{value}</T>
  </Row>
);

/** Sets the pump clock and writes the basal profile (read back by the bridge) before the pump is used. */
function FinishStep({ onConnected }: { onConnected: () => void }) {
  const c = useTrioColors();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const profile = useSettings((s) => s.profile);
  let summary: string;
  try {
    const r = simplifyBasalSchedule(profile.basal);
    summary = r.wasSimplified ? 'The Insight changes its basal rate on full hours only: your profile is converted to hourly rates (the lowest rate of each hour, rounded down).' : 'Your basal profile is written to the pump as it is.';
  } catch (e) {
    summary = errorText(e);
  }

  const sync = async () => {
    setBusy(true);
    setError(null);
    try {
      const pump = currentPump();
      if (!isInsightDriver(pump)) throw new Error('The Insight driver is not active.');
      const time = await pump.syncTime();
      if (!time.ok) throw new Error(time.error);
      const written = await pump.syncBasalProfile();
      if (!written.ok) throw new Error(written.error);
      onConnected();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Section header={stepHeader(5)}>
        <TextRow>Buddy now sets the pump clock and writes your basal profile to the pump.</TextRow>
        <TextRow>{summary}</TextRow>
        <TextRow secondary>Temp basals above 100 % stay off until the pump confirmed the profile.</TextRow>
      </Section>
      {error ? (
        <Section header="Not finished">
          <Row>
            <T color={c.red} style={{ flex: 1 }}>
              {error}
            </T>
          </Row>
        </Section>
      ) : null}
      <PrimaryButton label={busy ? 'Syncing…' : 'Sync and finish'} loading={busy} onPress={() => void sync()} />
      <View style={{ alignItems: 'center', paddingTop: 8 }}>
        <LinkButton label="Finish without syncing" onPress={onConnected} />
      </View>
    </>
  );
}
