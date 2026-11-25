import { router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Alert, Linking, Platform, View } from 'react-native';
import { pairLibreSensor, restartRuntime, useRuntime } from '@/runtime/runtime';
import { useSettings } from '@/runtime/settings-store';
import { CapsuleButton, PrimaryButton, Row, Section, SheetScreen, T, ToggleRow, useTrioColors } from '@/trio';
import { deleteDevice, deviceErrors, errorText, saveDeviceValues, useActiveDevice, useDeviceValues } from '@/features/devices/device-actions';
import { PluginForm } from '@/features/devices/plugin-form';

/** Trio CGM settings sheet (`CustomCGMOptionsView` / the CGM kit's settings) with "Delete CGM". */
export default function CgmSettings() {
  const c = useTrioColors();
  const active = useActiveDevice('cgm');
  const { values, setValue } = useDeviceValues(active?.plugin);
  const [busy, setBusy] = useState<null | 'save' | 'pair'>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [dirty, setDirty] = useState(false);
  const deviceError = useRuntime((s) => s.deviceError);
  const close = <CapsuleButton label="Close" onPress={() => router.back()} />;

  if (!active) {
    return (
      <SheetScreen title="CGM" leading={close}>
        <PrimaryButton label="Add CGM" onPress={() => router.replace('/add-cgm')} />
      </SheetScreen>
    );
  }
  const { plugin, entry } = active;
  const id = plugin.meta.id;

  const save = async () => {
    const errors = deviceErrors(plugin, values);
    if (errors.length) return setMessage({ text: errors.join('\n'), error: true });
    setBusy('save');
    setMessage(null);
    try {
      await saveDeviceValues(plugin, values);
      await restartRuntime();
      const err = useRuntime.getState().deviceError;
      if (err) throw new Error(err);
      setDirty(false);
      setMessage({ text: 'Configuration changes will take effect on the next glucose reading.', error: false });
    } catch (e) {
      setMessage({ text: errorText(e), error: true });
    } finally {
      setBusy(null);
    }
  };

  const pair = async () => {
    setBusy('pair');
    try {
      setMessage({ text: await pairLibreSensor(), error: false });
      await restartRuntime();
    } catch (e) {
      setMessage({ text: errorText(e), error: true });
    } finally {
      setBusy(null);
    }
  };

  const confirmDelete = () =>
    Alert.alert('Delete CGM', `Are you sure you want to delete ${entry.name}?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: `Delete ${entry.name}`,
        style: 'destructive',
        onPress: () =>
          void deleteDevice('cgm').then(
            () => router.back(),
            (e: unknown) => Alert.alert('Delete CGM', errorText(e)),
          ),
      },
    ]);

  const url = id === 'nightscout-cgm' ? String(values.url ?? '') : '';

  return (
    <SheetScreen
      title={entry.name}
      leading={close}
      trailing={dirty ? <CapsuleButton label="Save" onPress={() => void save()} /> : undefined}>
      <Section header="Configuration">
        <Row>
          <View style={{ flex: 1, gap: 10 }}>
            <T>CGM is not used as heartbeat.</T>
            {id === 'demo-cgm' ? <T style_="headline">Glucose trace IS affected by insulin and carb entries.</T> : null}
            <T style_="footnote" secondary>
              {id === 'demo-cgm'
                ? 'The simulator reads the same virtual patient as the Pump Simulator, with sensor lag and noise.'
                : plugin.meta.description}
            </T>
            <T style_="footnote" secondary>
              Configuration changes will take effect on the next glucose reading.
            </T>
          </View>
        </Row>
      </Section>

      {deviceError ? (
        <Section header="Status">
          <Row>
            <T color={c.red} style={{ flex: 1 }}>
              {deviceError}
            </T>
          </Row>
        </Section>
      ) : null}

      {plugin.meta.transport === 'network' ? <CloudLoopAcknowledgement id={id} name={entry.name} /> : null}

      <PluginForm
        sections={plugin.settings}
        values={values}
        onChange={(k, v) => {
          setDirty(true);
          setValue(k, v);
        }}
      />

      {id === 'libre-2-direct' ? (
        <Section footer={`Pair a new, warmed-up sensor: hold the back of your ${Platform.OS === 'android' ? 'phone' : 'iPhone'} to it.`}>
          <Row onPress={busy ? undefined : () => void pair()}>
            <T color={c.tabBar} style={{ flex: 1 }}>
              Pair New Sensor
            </T>
            {busy === 'pair' ? <ActivityIndicator /> : null}
          </Row>
        </Section>
      ) : null}

      {url.startsWith('https://') ? (
        <PrimaryButton label="Open Nightscout" color={c.fill} onPress={() => void Linking.openURL(url)} />
      ) : null}

      {message ? (
        <T color={message.error ? c.red : c.secondary} style={{ marginHorizontal: 20 }}>
          {message.text}
        </T>
      ) : null}
      {dirty ? <PrimaryButton label="Save" loading={busy === 'save'} onPress={() => void save()} /> : null}
      <PrimaryButton label="Delete CGM" color={c.red} onPress={confirmDelete} style={{ height: 44, borderRadius: 10 }} />
    </SheetScreen>
  );
}

/**
 * Cloud CGMs (LibreLinkUp, Dexcom Share, Nightscout) deliver readings minutes late. Closed loop with
 * one stays off until the user acknowledges that here (the gate checks `hardwareChecks[id]`).
 */
function CloudLoopAcknowledgement({ id, name }: { id: string; name: string }) {
  const acknowledged = useSettings((s) => Boolean(s.hardwareChecks[id]));
  const update = useSettings((s) => s.update);
  const setAcknowledged = (on: boolean) => {
    const checks = { ...useSettings.getState().hardwareChecks };
    if (on) checks[id] = Date.now();
    else delete checks[id];
    update({ hardwareChecks: checks });
    void restartRuntime();
  };
  return (
    <Section
      header="Closed Loop"
      footer={`${name} reads glucose from the cloud, typically several minutes behind the sensor. Readings older than your maximum glucose age stop all dosing.`}>
      <ToggleRow
        label="Allow closed loop with this CGM"
        value={acknowledged}
        onChange={(on) => {
          if (!on) return setAcknowledged(false);
          Alert.alert('Delayed glucose', `Closed loop will dose on ${name} readings that arrive with a delay. Use this only for bench testing.`, [
            { text: 'Cancel', style: 'cancel' },
            { text: 'I understand', onPress: () => setAcknowledged(true) },
          ]);
        }}
      />
    </Section>
  );
}
