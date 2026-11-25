import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import type { PumpPlugin } from '@buddy/core';
import { pumps } from '@/runtime/runtime';
import { PrimaryButton, Row, Section, T, useTrioColors } from '@/trio';
import type { CatalogEntry } from './catalog';
import { DanaSetup } from './dana-setup';
import { activateDevice, errorText, useDeviceValues } from './device-actions';
import { DeviceIcon } from './device-icon';
import { HardwareCheck } from './hardware-check';
import { BENCH_NOTE, MedtrumPatchFlow } from './medtrum-patch-flow';
import { PluginForm, TextFieldRow } from './plugin-form';
import { TextRow } from './setup-rows';

/**
 * Pump setup (Trio `PumpSetupView` → driver onboarding). Experimental drivers end with the
 * hardware check; it can be postponed, closed loop stays blocked until it is completed.
 */
export function PumpSetup({ entry, onFinished }: { entry: CatalogEntry; onFinished: () => void }) {
  const plugin = pumps.get(entry.pluginIds[0] ?? '');
  const [connected, setConnected] = useState(false);
  if (!plugin) return <T secondary>{entry.name} is not available in this build.</T>;
  if (connected && plugin.meta.requiresHardwareCheck) return <HardwareCheckStep pumpId={plugin.meta.id} onFinished={onFinished} />;
  const done = () => (plugin.meta.requiresHardwareCheck ? setConnected(true) : onFinished());
  switch (plugin.meta.id) {
    case 'dana-i':
      return <DanaSetup plugin={plugin} entryId={entry.id} onConnected={done} />;
    case 'medtrum-nano':
      return <MedtrumSetup plugin={plugin} entry={entry} onConnected={done} />;
    default:
      return <InstantSetup plugin={plugin} entry={entry} onConnected={done} />;
  }
}

function HardwareCheckStep({ pumpId, onFinished }: { pumpId: string; onFinished: () => void }) {
  const c = useTrioColors();
  return (
    <>
      <HardwareCheck pumpId={pumpId} onDone={onFinished} />
      <PrimaryButton label="Not Now" color={c.fill} onPress={onFinished} />
    </>
  );
}

/** Simulators (MockKit) need no onboarding: selecting them completes setup. */
function InstantSetup({ plugin, entry, onConnected }: { plugin: PumpPlugin; entry: CatalogEntry; onConnected: () => void }) {
  const c = useTrioColors();
  const { values, loaded } = useDeviceValues(plugin);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!loaded) return;
    activateDevice('pump', plugin, values, entry.id).then(onConnected, (e: unknown) => setError(errorText(e)));
    // Runs once the stored values are loaded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);
  return (
    <Section>
      <Row>
        {error ? null : <ActivityIndicator />}
        <T color={error ? c.red : undefined} style={{ flex: 1 }}>
          {error ?? `Setting up ${entry.name}…`}
        </T>
      </Row>
    </Section>
  );
}

type MedtrumStep = 'welcome' | 'base' | 'patchSettings' | 'patch';

/** MedtrumKit onboarding: welcome → pump base serial → patch settings → fill, prime, activate. */
function MedtrumSetup({ plugin, entry, onConnected }: { plugin: PumpPlugin; entry: CatalogEntry; onConnected: () => void }) {
  const c = useTrioColors();
  const { values, setValue } = useDeviceValues(plugin);
  const [step, setStep] = useState<MedtrumStep>('welcome');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      await activateDevice('pump', plugin, values, entry.id);
      setStep('patch');
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
    case 'welcome':
      return (
        <>
          <Section>
            <View style={{ alignItems: 'center', paddingVertical: 16 }}>
              <DeviceIcon entry={entry} size={120} background="transparent" />
            </View>
            <TextRow>You will start by setting up your basic patch settings before activating your patch.</TextRow>
          </Section>
          <PrimaryButton label="Continue" onPress={() => setStep('base')} />
        </>
      );
    case 'base': {
      const serial = String(values.serialNumber ?? '');
      return (
        <>
          <Section footer="Make sure the Serial Number is correct before connecting it to the patch.">
            <TextFieldRow label="Serial number" value={serial} placeholder="1234ABCD" autoCapitalize="characters" maxLength={8} onChangeText={(t) => setValue('serialNumber', t.toUpperCase())} />
          </Section>
          {errorLine}
          <PrimaryButton
            label="Save and continue"
            disabled={!/^[0-9A-F]{8}$/.test(serial)}
            onPress={() => {
              setError(null);
              setStep('patchSettings');
            }}
          />
        </>
      );
    }
    case 'patchSettings':
      return (
        <>
          <PluginForm sections={plugin.settings} values={values} onChange={setValue} keys={['alarmSetting', 'expiryMode', 'maxHourlyInsulin', 'maxDailyInsulin']} />
          {errorLine}
          <PrimaryButton label="Save and continue" loading={busy} onPress={() => void connect()} />
        </>
      );
    case 'patch':
      return (
        <>
          <Section footer={BENCH_NOTE}>
            <TextRow secondary>Pump base {String(values.serialNumber)} is connected. Prime and activate a patch now, or later from the pump settings.</TextRow>
          </Section>
          <MedtrumPatchFlow onActivated={onConnected} />
          <PrimaryButton label="Continue Without Patch" color={c.fill} onPress={onConnected} />
        </>
      );
  }
}
