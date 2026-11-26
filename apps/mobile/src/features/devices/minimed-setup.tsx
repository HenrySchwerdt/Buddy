// Medtronic MiniMed onboarding for the TypeScript port of MinimedKit (MIT License, (c) LoopKit Authors).
import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import type { PumpPlugin } from '@buddy/core';
import { isMinimedDriver, readMinimedStatus, refreshMinimed, scanForRileyLinks, tuneMinimedRadio, type MinimedPumpStatus, type RileyLinkAdvertisement } from '@buddy/devices';
import { currentPump } from '@/runtime/runtime';
import { bleTransport } from '@/runtime/transports/ble';
import { PrimaryButton, Row, Section, T, useTrioColors, ValueRow } from '@/trio';
import type { CatalogEntry } from './catalog';
import { activateDevice, errorText, useDeviceValues } from './device-actions';
import { DeviceIcon } from './device-icon';
import { PluginForm } from './plugin-form';
import { ChoiceRow, TextRow } from './setup-rows';

const SCAN_MS = 10_000;

type Step = 'intro' | 'rileyLink' | 'pump' | 'check';

const rssiText = (rssi: number | null) => (rssi === null ? 'Signal unknown' : `${rssi} dBm`);
const fmtDate = (ms: number) => (ms > 0 ? new Date(ms).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : 'Never');

/** Experimental: this driver has never run on a real pump. */
const MINIMED_NOTE = 'Experimental. This driver has never been verified on a real pump. Use it on the bench only, with water, and never to deliver insulin to a person.';

/**
 * MiniMed onboarding: intro → pick the RileyLink → pump serial number, region and model →
 * read the pump once (model, reservoir, battery) and, when it does not answer, search for its radio channel.
 */
export function MinimedSetup({ plugin, entry, onConnected }: { plugin: PumpPlugin; entry: CatalogEntry; onConnected: () => void }) {
  const c = useTrioColors();
  const { values, setValue } = useDeviceValues(plugin);
  const [step, setStep] = useState<Step>('intro');
  const [found, setFound] = useState<readonly RileyLinkAdvertisement[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanRun, setScanRun] = useState(0);
  const [busy, setBusy] = useState<null | 'save' | 'read' | 'tune'>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<MinimedPumpStatus | null>(null);
  const selected = String(values.rileyLinkId ?? '');
  const serialOk = /^[0-9]{6}$/.test(String(values.pumpSerial ?? '').trim());

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

  const driver = () => {
    const d = currentPump();
    return d && isMinimedDriver(d) ? d : null;
  };

  const save = async () => {
    setBusy('save');
    setError(null);
    try {
      await activateDevice('pump', plugin, values, entry.id);
      setStep('check');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const run = async (kind: 'read' | 'tune') => {
    const d = driver();
    if (!d) return;
    setBusy(kind);
    setError(null);
    try {
      const result = kind === 'read' ? await refreshMinimed(d) : await tuneMinimedRadio(d);
      if (!result.ok) setError(result.error);
      setStatus(await readMinimedStatus(d));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
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
          <Section footer={MINIMED_NOTE}>
            <View style={{ alignItems: 'center', paddingVertical: 16 }}>
              <DeviceIcon entry={entry} size={120} background="transparent" />
            </View>
            <TextRow>{plugin.meta.description}</TextRow>
            <TextRow secondary>A MiniMed pump talks radio, not Bluetooth. A RileyLink (or compatible bridge) next to the phone relays the messages. Switch it on and keep it close to the pump.</TextRow>
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
            <PrimaryButton label="Continue" disabled={!selected} onPress={() => setStep('pump')} />
            {!scanning ? <PrimaryButton label="Scan Again" color={c.fill} onPress={() => setScanRun((n) => n + 1)} /> : null}
          </View>
        </>
      );
    case 'pump':
      return (
        <>
          <PluginForm sections={plugin.settings} values={values} onChange={setValue} keys={['pumpSerial', 'pumpRegion', 'pumpModel']} />
          {!serialOk && String(values.pumpSerial ?? '') ? (
            <T color={c.red} style={{ marginHorizontal: 20 }}>
              The serial number has 6 digits.
            </T>
          ) : null}
          {errorLine}
          <PrimaryButton label="Save and continue" loading={busy === 'save'} disabled={!serialOk} onPress={() => void save()} />
        </>
      );
    case 'check':
      return (
        <>
          <Section header="Pump" footer={MINIMED_NOTE}>
            {status ? (
              <>
                <ValueRow label="Model" value={status.model ?? 'Not read yet'} />
                <ValueRow label="Reservoir" value={status.reservoirUnits !== null ? `${status.reservoirUnits.toFixed(2)} U` : '–'} />
                <ValueRow label="Battery" value={status.batteryPercent !== null ? `${status.batteryPercent} %` : '–'} />
                <ValueRow label="Last read" value={fmtDate(status.lastSync)} />
              </>
            ) : (
              <TextRow secondary>RileyLink and pump saved. Read the pump to check the connection.</TextRow>
            )}
          </Section>
          {errorLine}
          <View style={{ gap: 12 }}>
            <PrimaryButton label="Read Pump" loading={busy === 'read'} onPress={() => void run('read')} />
            <PrimaryButton label="Search for Pump" color={c.fill} loading={busy === 'tune'} onPress={() => void run('tune')} />
            <PrimaryButton label="Done" color={c.fill} onPress={onConnected} />
          </View>
        </>
      );
  }
}
