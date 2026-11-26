import { router } from 'expo-router';
import { SymbolView } from '@/trio/symbol';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, View } from 'react-native';
import { HOUR, scheduleValueAt } from '@buddy/core';
import { isMedtrumNanoDriver, readMedtrumPatchStatus } from '@buddy/devices';
import { currentPump, now, restartRuntime, setPumpSuspended, store, useRuntime } from '@/runtime/runtime';
import { useSettings } from '@/runtime/settings-store';
import { CapsuleButton, NavRow, PrimaryButton, Row, Section, SheetScreen, T, useTrioColors, ValueRow } from '@/trio';
import { deleteDevice, deviceErrors, errorText, saveDeviceValues, useActiveDevice, useDeviceValues } from '@/features/devices/device-actions';
import { MedtrumPatchFlow } from '@/features/devices/medtrum-patch-flow';
import { OmnipodErosPodFlow } from '@/features/devices/omnipod-eros-pod-flow';
import { OmnipodPodFlow } from '@/features/devices/omnipod-pod-flow';
import { PluginForm } from '@/features/devices/plugin-form';
import { upTo3 } from '@/features/history/rows';
import { PumpStatusCard, type PumpLife } from '@/features/devices/pump-status-card';
import { TempBasalEntry } from '@/features/devices/temp-basal-entry';

type Page = 'main' | 'device' | 'patch' | 'tempBasal';

const DAY = 24 * HOUR;
const PATCH_LIFE = 72 * HOUR;

/** Trio pump settings sheet (PumpSettingsView → the driver's settings view, MockKit layout). */
export default function PumpSettings() {
  const active = useActiveDevice('pump');
  const [page, setPage] = useState<Page>('main');
  if (!active) {
    return (
      <SheetScreen title="Insulin Pump" trailing={<CapsuleButton label="Done" onPress={() => router.back()} />}>
        <PrimaryButton label="Add Pump" onPress={() => router.replace('/add-pump')} />
      </SheetScreen>
    );
  }
  const { plugin } = active;
  const back = <CapsuleButton icon="chevron.left" accessibilityLabel="Back" onPress={() => setPage('main')} />;
  switch (page) {
    case 'device':
      return (
        <SheetScreen title={plugin.meta.maturity === 'simulator' ? 'Simulator Settings' : 'Pump Settings'} leading={back}>
          <DeviceSettingsPage onSaved={() => setPage('main')} />
        </SheetScreen>
      );
    case 'patch':
      return (
        <SheetScreen title={plugin.meta.id === 'medtrum-nano' ? 'Patch' : 'Pod'} leading={back}>
          {plugin.meta.id === 'medtrum-nano' ? <MedtrumPatchFlow /> : plugin.meta.id === 'omnipod-eros' ? <OmnipodErosPodFlow /> : <OmnipodPodFlow />}
        </SheetScreen>
      );
    case 'tempBasal':
      return (
        <SheetScreen title="Temporary Basal" trailing={<CapsuleButton label="Cancel" onPress={() => setPage('main')} />}>
          <TempBasalEntry onDone={() => setPage('main')} />
        </SheetScreen>
      );
    default:
      return <MainPage onNavigate={setPage} />;
  }
}

function usePumpLife(pluginId: string, batteryPercent: number | null): PumpLife | null {
  const [activatedAt, setActivatedAt] = useState<number | null>(null);
  useEffect(() => {
    const driver = currentPump();
    if (pluginId !== 'medtrum-nano' || !driver || !isMedtrumNanoDriver(driver)) return;
    readMedtrumPatchStatus(driver)
      .then((s) => setActivatedAt(s.patchActivatedAt))
      .catch(() => setActivatedAt(null));
  }, [pluginId]);
  if (activatedAt) {
    const left = Math.max(0, activatedAt + PATCH_LIFE - now());
    const days = left >= DAY;
    return {
      title: 'Patch expires in',
      value: String(Math.floor(days ? left / DAY : left / HOUR)),
      unit: days ? (left >= 2 * DAY ? 'days' : 'day') : 'hours',
      progress: left / PATCH_LIFE,
    };
  }
  if (batteryPercent == null) return null;
  return { title: 'Pump battery', value: String(Math.round(batteryPercent)), unit: '%', progress: batteryPercent / 100 };
}

function MainPage({ onNavigate }: { onNavigate: (p: Page) => void }) {
  const c = useTrioColors();
  const { plugin, entry } = useActiveDevice('pump')!;
  const pump = useRuntime((s) => s.pump);
  const nowMs = useRuntime((s) => s.now);
  const s = useSettings();
  const [transitioning, setTransitioning] = useState(false);
  const [cancelingTemp, setCancelingTemp] = useState(false);
  const life = usePumpLife(plugin.meta.id, pump?.batteryPercent ?? null);
  const openLoop = s.loopMode === 'open';
  const temp = pump?.tempBasal && pump.tempBasal.startedAt + pump.tempBasal.durationMin * 60_000 > nowMs ? pump.tempBasal : null;
  const suspended = pump?.suspended ?? false;
  const scheduled = scheduleValueAt(s.profile.basal, nowMs, s.profile.utcOffsetMinutes);

  const toggleSuspend = () => {
    const go = async () => {
      setTransitioning(true);
      try {
        await setPumpSuspended(!suspended);
      } catch (e) {
        Alert.alert(suspended ? 'Failed to Resume Insulin Delivery' : 'Failed to Suspend Insulin Delivery', errorText(e));
      } finally {
        setTransitioning(false);
      }
    };
    if (suspended) return void go();
    Alert.alert('Suspend Insulin Delivery', 'Insulin delivery stays suspended until you resume it.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Suspend', style: 'destructive', onPress: () => void go() },
    ]);
  };

  const cancelTemp = async () => {
    const driver = currentPump();
    if (!driver) return;
    setCancelingTemp(true);
    try {
      const r = await driver.cancelTempBasal();
      if (!r.ok) throw new Error(r.error);
      store.addDoses(await driver.history(now() - HOUR));
      useRuntime.setState({ pump: await driver.status() });
    } catch (e) {
      Alert.alert('Failed to Cancel Manual Basal', errorText(e));
    } finally {
      setCancelingTemp(false);
    }
  };

  const confirmDelete = () =>
    Alert.alert('Delete Pump', `Are you sure you want to delete ${entry.name}?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: `Delete ${entry.name}`,
        style: 'destructive',
        onPress: () =>
          void deleteDevice('pump').then(
            () => router.back(),
            (e: unknown) => Alert.alert('Delete Pump', errorText(e)),
          ),
      },
    ]);

  return (
    <SheetScreen
      title=""
      trailing={<CapsuleButton label="Done" onPress={() => router.back()} />}>
      <PumpStatusCard entry={entry} state={pump} life={life} nowMs={nowMs} />

      {plugin.meta.maturity === 'simulator' ? (
        <Section>
          <NavRow label="Simulator Settings" onPress={() => onNavigate('device')} />
        </Section>
      ) : null}

      <Section header="Activity">
        <Row onPress={transitioning || !pump ? undefined : toggleSuspend}>
          {suspended ? <SymbolView name="pause.circle.fill" size={22} tintColor={c.orange} /> : null}
          <T color={c.tabBar} style={{ flex: 1 }}>
            {suspended ? 'Resume Insulin Delivery' : 'Suspend Insulin Delivery'}
          </T>
          {transitioning ? <ActivityIndicator /> : null}
        </Row>
      </Section>

      <Section footer={openLoop ? undefined : 'Manual temporary basal rates are only available while the loop is open.'}>
        {temp && openLoop ? (
          <Row onPress={cancelingTemp ? undefined : () => void cancelTemp()}>
            {cancelingTemp ? <ActivityIndicator /> : <SymbolView name="exclamationmark.circle.fill" size={22} tintColor={c.orange} />}
            <T color={c.tabBar} style={{ flex: 1 }}>
              Cancel Manual Basal
            </T>
          </Row>
        ) : null}
        {temp && openLoop ? (
          <ValueRow label="Remaining" value={`${Math.max(0, Math.round((temp.startedAt + temp.durationMin * 60_000 - nowMs) / 60_000))} min`} />
        ) : null}
        {!(temp && openLoop) ? (
          <Row onPress={openLoop && !suspended && pump ? () => onNavigate('tempBasal') : undefined}>
            <T color={openLoop && !suspended && pump ? c.tabBar : c.tertiary} style={{ flex: 1 }}>
              Set Temporary Basal Rate
            </T>
          </Row>
        ) : null}
      </Section>

      <Section>
        <NavRow
          label="Notification Settings"
          onPress={() => {
            router.back();
            router.push('/settings/notifications');
          }}
        />
      </Section>

      <Section header="Configuration">
        {plugin.meta.maturity !== 'simulator' ? <NavRow label="Pump Settings" onPress={() => onNavigate('device')} /> : null}
        {plugin.meta.id === 'medtrum-nano' ? <NavRow label="Patch" onPress={() => onNavigate('patch')} /> : null}
        {plugin.meta.id === 'omnipod-dash' || plugin.meta.id === 'omnipod-eros' ? <NavRow label="Pod" onPress={() => onNavigate('patch')} /> : null}
        <ValueRow label="Current Basal Rate" value={`${upTo3(temp ? temp.rate : scheduled)} U/hr`} />
        <ValueRow label="Last Sync" value={pump ? new Date(pump.lastSync).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '--'} />
      </Section>
      <PrimaryButton label="Delete Pump" color={c.red} onPress={confirmDelete} style={{ height: 44, borderRadius: 10 }} />
    </SheetScreen>
  );
}

/** Driver settings (or "Simulator Settings"): the plugin's schema, applied with a reconnect. */
function DeviceSettingsPage({ onSaved }: { onSaved: () => void }) {
  const c = useTrioColors();
  const { plugin } = useActiveDevice('pump')!;
  const { values, setValue } = useDeviceValues(plugin);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    const errors = deviceErrors(plugin, values);
    if (errors.length) return setError(errors.join('\n'));
    setBusy(true);
    setError(null);
    try {
      await saveDeviceValues(plugin, values);
      await restartRuntime();
      const deviceError = useRuntime.getState().deviceError;
      if (deviceError) throw new Error(deviceError);
      onSaved();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PluginForm sections={plugin.settings} values={values} onChange={setValue} />
      {error ? (
        <T color={c.red} style={{ marginHorizontal: 20 }}>
          {error}
        </T>
      ) : null}
      <PrimaryButton label="Save" loading={busy} onPress={() => void save()} />
    </>
  );
}
