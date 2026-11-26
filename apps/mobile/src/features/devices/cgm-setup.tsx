import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Platform } from 'react-native';
import type { CgmPlugin } from '@buddy/core';
import { cgms, pairLibre3, pairLibreSensor } from '@/runtime/runtime';
import { PrimaryButton, Row, Section, T, useTrioColors } from '@/trio';
import type { CatalogEntry } from './catalog';
import { activateDevice, errorText, useDeviceValues } from './device-actions';
import { PluginForm, TextFieldRow } from './plugin-form';
import { ChoiceRow, TextRow } from './setup-rows';

/** CGM setup (Trio `CGMSetupView` / `CustomCGMOptionsView`), one flow per Buddy CGM plugin. */
export function CgmSetup({ entry, onFinished }: { entry: CatalogEntry; onFinished: () => void }) {
  if (entry.pluginIds.length > 1) return <LibreSetup entry={entry} onFinished={onFinished} />;
  const plugin = cgms.get(entry.pluginIds[0] ?? '');
  if (!plugin) return <T secondary>{entry.name} is not available in this build.</T>;
  if (plugin.meta.id === 'demo-cgm') return <InstantCgmSetup plugin={plugin} entry={entry} onFinished={onFinished} />;
  if (plugin.meta.id === 'dexcom-g6') return <TransmitterSetup plugin={plugin} entry={entry} onFinished={onFinished} />;
  if (plugin.meta.id === 'libre-3-direct') return <Libre3Setup plugin={plugin} entry={entry} onFinished={onFinished} />;
  return <FormSetup plugin={plugin} entry={entry} onFinished={onFinished} />;
}

function useConnect(plugin: CgmPlugin | undefined, entry: CatalogEntry, onFinished: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connect = async (values: Parameters<typeof activateDevice>[2]) => {
    if (!plugin) return;
    setBusy(true);
    setError(null);
    try {
      await activateDevice('cgm', plugin, values, entry.id);
      onFinished();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, connect };
}

function ErrorText({ error }: { error: string | null }) {
  const c = useTrioColors();
  return error ? (
    <T color={c.red} style={{ marginHorizontal: 20 }}>
      {error}
    </T>
  ) : null;
}

function InstantCgmSetup({ plugin, entry, onFinished }: { plugin: CgmPlugin; entry: CatalogEntry; onFinished: () => void }) {
  const { values, loaded } = useDeviceValues(plugin);
  const { error, connect } = useConnect(plugin, entry, onFinished);
  useEffect(() => {
    if (loaded) void connect(values);
    // Runs once the stored values are loaded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);
  return (
    <>
      <Section>
        <Row>
          {error ? null : <ActivityIndicator />}
          <T style={{ flex: 1 }}>{error ? 'Setup failed.' : `Setting up ${entry.name}…`}</T>
        </Row>
      </Section>
      <ErrorText error={error} />
    </>
  );
}

/** CGMBLEKit transmitter setup: "Transmitter ID". */
function TransmitterSetup({ plugin, entry, onFinished }: { plugin: CgmPlugin; entry: CatalogEntry; onFinished: () => void }) {
  const { values, setValue } = useDeviceValues(plugin);
  const { busy, error, connect } = useConnect(plugin, entry, onFinished);
  const id = String(values.transmitterId ?? '');
  return (
    <>
      <Section
        header="Transmitter ID"
        footer="The transmitter ID can be found printed on the back of the device, on the side of the box it came in, and from within the settings menus of the receiver and mobile app.">
        <TextFieldRow label="Transmitter ID" value={id} placeholder="Enter the 6-digit transmitter ID" autoCapitalize="characters" maxLength={6} onChangeText={(t) => setValue('transmitterId', t.toUpperCase())} />
      </Section>
      <PluginForm sections={plugin.settings} values={values} onChange={setValue} keys={['passiveMode']} headers={false} />
      <ErrorText error={error} />
      <PrimaryButton label="Continue" disabled={id.length !== 6} loading={busy} onPress={() => void connect(values)} />
    </>
  );
}

/** Network and passive sources: the plugin's own fields (Nightscout, Dexcom Share, G7). */
function FormSetup({ plugin, entry, onFinished }: { plugin: CgmPlugin; entry: CatalogEntry; onFinished: () => void }) {
  const { values, setValue } = useDeviceValues(plugin);
  const { busy, error, connect } = useConnect(plugin, entry, onFinished);
  return (
    <>
      <Section header="Configuration">
        <TextRow secondary>{plugin.meta.description}</TextRow>
      </Section>
      <PluginForm sections={plugin.settings} values={values} onChange={setValue} />
      <ErrorText error={error} />
      <PrimaryButton label="Continue" loading={busy} onPress={() => void connect(values)} />
    </>
  );
}

/** LibreTransmitter: direct Libre 2 over Bluetooth (NFC pairing) or a MiaoMiao / Bubble bridge. */
function LibreSetup({ entry, onFinished }: { entry: CatalogEntry; onFinished: () => void }) {
  const c = useTrioColors();
  const [mode, setMode] = useState<'libre-2-direct' | 'libre-transmitter'>('libre-2-direct');
  const plugin = cgms.get(mode);
  const { values, setValue } = useDeviceValues(plugin);
  const { busy, error, connect } = useConnect(plugin, entry, onFinished);
  const [paired, setPaired] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);

  const pair = async () => {
    setPairing(true);
    setPairError(null);
    try {
      setPaired(await pairLibreSensor());
    } catch (e) {
      setPairError(errorText(e));
    } finally {
      setPairing(false);
    }
  };

  return (
    <>
      <Section header="Connection">
        <ChoiceRow title="Libre 2 Direct" description={cgms.get('libre-2-direct')?.meta.description} selected={mode === 'libre-2-direct'} onPress={() => setMode('libre-2-direct')} />
        <ChoiceRow title="MiaoMiao / Bubble" description={cgms.get('libre-transmitter')?.meta.description} selected={mode === 'libre-transmitter'} onPress={() => setMode('libre-transmitter')} />
      </Section>
      {mode === 'libre-2-direct' ? (
        <>
          <Section header="Sensor" footer={`Hold the ${Platform.OS === 'android' ? 'back of your phone' : 'top of your iPhone'} to the warmed-up sensor. Buddy reads it via NFC and enables Bluetooth streaming.`}>
            <Row onPress={pairing ? undefined : () => void pair()}>
              <T color={c.tabBar} style={{ flex: 1 }}>
                Pair Sensor
              </T>
              {pairing ? <ActivityIndicator /> : null}
            </Row>
            {paired ? <TextRow secondary>{paired}</TextRow> : null}
          </Section>
          <ErrorText error={pairError} />
        </>
      ) : plugin ? (
        <PluginForm sections={plugin.settings} values={values} onChange={setValue} />
      ) : null}
      <ErrorText error={error} />
      <PrimaryButton label="Continue" disabled={mode === 'libre-2-direct' && !paired} loading={busy} onPress={() => void connect(values)} />
    </>
  );
}

const confirmActivation = () =>
  new Promise<boolean>((resolve) =>
    Alert.alert('Activate new sensor?', 'This sensor has not been started yet. Activating it starts its 60-minute warm-up and its wear time, and cannot be undone.', [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      { text: 'Activate', onPress: () => resolve(true) },
    ]),
  );

/** LibreLoop onboarding: app credential → NFC scan (activate or switch receiver) → Bluetooth. */
function Libre3Setup({ plugin, entry, onFinished }: { plugin: CgmPlugin; entry: CatalogEntry; onFinished: () => void }) {
  const c = useTrioColors();
  const { values, setValue } = useDeviceValues(plugin);
  const { busy, error, connect } = useConnect(plugin, entry, onFinished);
  const [paired, setPaired] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);
  const credential = String(values.appCredential ?? '');

  const pair = async () => {
    setPairing(true);
    setPairError(null);
    try {
      let result = await pairLibre3(credential, false);
      if (result.kind === 'needsActivation') {
        if (!(await confirmActivation())) return;
        result = await pairLibre3(credential, true);
      }
      if (result.kind === 'paired') setPaired(result.text);
    } catch (e) {
      setPairError(errorText(e));
    } finally {
      setPairing(false);
    }
  };

  return (
    <>
      <Section header="Configuration">
        <TextRow secondary>{plugin.meta.description}</TextRow>
      </Section>
      <PluginForm sections={plugin.settings} values={values} onChange={setValue} keys={['appCredential']} headers={false} />
      <Section header="Sensor" footer={`Hold the ${Platform.OS === 'android' ? 'back of your phone' : 'top of your iPhone'} to the sensor. A new sensor is only activated after you confirm.`}>
        <Row onPress={pairing ? undefined : () => void pair()}>
          <T color={c.tabBar} style={{ flex: 1 }}>
            Pair Sensor
          </T>
          {pairing ? <ActivityIndicator /> : null}
        </Row>
        {paired ? <TextRow secondary>{paired}</TextRow> : null}
      </Section>
      <ErrorText error={pairError} />
      <PluginForm sections={plugin.settings} values={values} onChange={setValue} keys={['minuteByMinute', 'useNonActionable']} headers={false} />
      <ErrorText error={error} />
      <PrimaryButton label="Continue" disabled={!paired} loading={busy} onPress={() => void connect(values)} />
    </>
  );
}
