// Omnipod Eros onboarding for the TypeScript port of OmnipodKit (MIT License, (c) LoopKit Authors).
import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import type { PumpPlugin } from '@buddy/core';
import { scanForRileyLinks, type RileyLinkAdvertisement } from '@buddy/devices';
import { bleTransport } from '@/runtime/transports/ble';
import { PrimaryButton, Row, Section, T, useTrioColors } from '@/trio';
import type { CatalogEntry } from './catalog';
import { activateDevice, errorText, useDeviceValues } from './device-actions';
import { DeviceIcon } from './device-icon';
import { POD_BENCH_NOTE } from './omnipod-pod-flow';
import { OmnipodErosPodFlow } from './omnipod-eros-pod-flow';
import { PluginForm } from './plugin-form';
import { ChoiceRow, TextRow } from './setup-rows';

const SCAN_MS = 10_000;

type Step = 'intro' | 'rileyLink' | 'settings' | 'pod';

/** RileyLink signal as the text shown next to its name. */
const rssiText = (rssi: number | null) => (rssi === null ? 'Signal unknown' : `${rssi} dBm`);

/**
 * Omnipod (Eros) onboarding: intro → pick the RileyLink → pod alert settings → pair, prime and
 * start a pod (or later from Pump Settings → Pod). Bench only: the pod holds water.
 */
export function OmnipodErosSetup({ plugin, entry, onConnected }: { plugin: PumpPlugin; entry: CatalogEntry; onConnected: () => void }) {
  const c = useTrioColors();
  const { values, setValue } = useDeviceValues(plugin);
  const [step, setStep] = useState<Step>('intro');
  const [found, setFound] = useState<readonly RileyLinkAdvertisement[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanRun, setScanRun] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = String(values.rileyLinkId ?? '');

  useEffect(() => {
    if (step !== 'rileyLink') return;
    let active = true;
    setScanning(true);
    setError(null);
    scanForRileyLinks(bleTransport, {
      timeoutMs: SCAN_MS,
      onFound: (ad) => active && setFound((old) => (old.some((o) => o.id === ad.id) ? old : [...old, ad])),
    })
      .catch((e: unknown) => active && setError(errorText(e)))
      .finally(() => active && setScanning(false));
    return () => {
      active = false;
      bleTransport.stopScan();
    };
  }, [step, scanRun]);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      await activateDevice('pump', plugin, values, entry.id);
      setStep('pod');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const errorLine = error ? (
    <T color={c.red} style={{ marginHorizontal: 20 }}>
      {error}
    </T>
  ) : null;

  switch (step) {
    case 'intro':
      return (
        <>
          <Section footer={POD_BENCH_NOTE}>
            <View style={{ alignItems: 'center', paddingVertical: 16 }}>
              <DeviceIcon entry={entry} size={120} background="transparent" />
            </View>
            <TextRow>{plugin.meta.description}</TextRow>
            <TextRow secondary>An Eros pod talks radio, not Bluetooth. A RileyLink (or compatible bridge) next to the phone relays the messages. Switch it on and keep it close to the pod.</TextRow>
          </Section>
          <PrimaryButton label="Continue" onPress={() => setStep('rileyLink')} />
        </>
      );
    case 'rileyLink':
      return (
        <>
          <Section header={scanning ? 'Scanning for RileyLinks' : 'RileyLinks'}>
            {found.map((ad) => (
              <ChoiceRow key={ad.id} title={ad.name ?? 'RileyLink'} description={rssiText(ad.rssi)} selected={selected === ad.id} onPress={() => setValue('rileyLinkId', ad.id)} />
            ))}
            {!found.length ? (
              <Row>
                {scanning ? <ActivityIndicator /> : null}
                <T secondary style={{ flex: 1 }}>
                  {scanning ? 'Looking for RileyLinks…' : 'No RileyLink found. Check that it is switched on and nearby.'}
                </T>
              </Row>
            ) : null}
          </Section>
          {errorLine}
          <View style={{ gap: 12 }}>
            <PrimaryButton label="Continue" disabled={!selected} onPress={() => setStep('settings')} />
            {!scanning ? <PrimaryButton label="Scan Again" color={c.fill} onPress={() => setScanRun((n) => n + 1)} /> : null}
          </View>
        </>
      );
    case 'settings':
      return (
        <>
          <PluginForm sections={plugin.settings} values={values} onChange={setValue} keys={['lowReservoirUnits', 'expirationReminderHours', 'silentAlerts']} />
          {errorLine}
          <PrimaryButton label="Save and continue" loading={busy} onPress={() => void connect()} />
        </>
      );
    case 'pod':
      return (
        <>
          <Section footer={POD_BENCH_NOTE}>
            <TextRow secondary>RileyLink saved. Pair, prime and start a pod now, or later from Pump Settings → Pod.</TextRow>
          </Section>
          <OmnipodErosPodFlow onActivated={onConnected} />
          <PrimaryButton label="Continue Without Pod" color={c.fill} onPress={onConnected} />
        </>
      );
  }
}
