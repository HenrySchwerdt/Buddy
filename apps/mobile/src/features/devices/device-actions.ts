import Storage from 'expo-sqlite/kv-store';
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { normalizeSettings, validateSettings, type CgmPlugin, type PumpPlugin, type SettingsValues } from '@buddy/core';
import { cgms, currentPump, pumps, restartRuntime, useRuntime } from '@/runtime/runtime';
import { loadSecrets, saveSecret, secretFields } from '@/runtime/secrets';
import { useSettings } from '@/runtime/settings-store';
import { entryForPlugin, setupErrors, type CatalogEntry, type DeviceKind } from './catalog';

type Plugin = PumpPlugin | CgmPlugin;

/** Which picker entry the active plugin was chosen from (G5 vs G6 share one driver). */
interface DeviceUiState {
  readonly pumpEntryId: string | null;
  readonly cgmEntryId: string | null;
  setEntry(kind: DeviceKind, id: string | null): void;
}

export const useDeviceUi = create<DeviceUiState>()(
  persist(
    (set) => ({
      pumpEntryId: null,
      cgmEntryId: null,
      setEntry: (kind, id) => set(kind === 'pump' ? { pumpEntryId: id } : { cgmEntryId: id }),
    }),
    { name: 'buddy.devices.v1', storage: createJSONStorage(() => Storage), partialize: ({ setEntry: _s, ...rest }) => rest },
  ),
);

/** Shadow mode (nightscout-follower) is not offered in the UI any more. */
const HIDDEN_PUMPS = new Set(['nightscout-follower']);

export const pluginFor = (kind: DeviceKind, id: string): Plugin | undefined => (kind === 'pump' ? pumps.get(id) : cgms.get(id));

/** The configured device of a kind, or null when none is set up (Trio's "Add Pump" / "Add CGM" state). */
export function useActiveDevice(kind: DeviceKind): { plugin: Plugin; entry: CatalogEntry } | null {
  const id = useSettings((s) => (kind === 'pump' ? s.pumpId : s.cgmId));
  const entryId = useDeviceUi((s) => (kind === 'pump' ? s.pumpEntryId : s.cgmEntryId));
  if (!id || (kind === 'pump' && HIDDEN_PUMPS.has(id))) return null;
  const plugin = pluginFor(kind, id);
  const entry = plugin ? entryForPlugin(kind, plugin.meta.id, entryId) : null;
  return plugin && entry ? { plugin, entry } : null;
}

/** Current settings of a plugin (stored values + keychain secrets), editable locally. */
export function useDeviceValues(plugin: Plugin | undefined) {
  const stored = useSettings((s) => (plugin ? s.deviceSettings[plugin.meta.id] : undefined));
  const [values, setValues] = useState<SettingsValues>({});
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!plugin) return;
    let cancelled = false;
    const base = normalizeSettings(plugin.settings, plugin.defaultSettings, stored);
    setValues(base);
    loadSecrets(plugin.meta.id, plugin.settings)
      .then((secrets) => {
        if (!cancelled) setValues({ ...base, ...secrets });
      })
      .catch(() => undefined)
      .finally(() => !cancelled && setLoaded(true));
    return () => {
      cancelled = true;
    };
    // Reload only when the plugin changes, not on every store write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plugin?.meta.id]);
  const setValue = (key: string, v: string | number | boolean) => setValues((old) => ({ ...old, [key]: v }));
  return { values, setValue, setValues, loaded };
}

/** Schema + driver-specific validation; empty when the values can be applied. */
export function deviceErrors(plugin: Plugin, values: SettingsValues): string[] {
  return [...validateSettings(plugin.settings, values), ...setupErrors(plugin.meta.id, values)];
}

/** Persists values (secrets to the keychain) without switching devices. */
export async function saveDeviceValues(plugin: Plugin, values: SettingsValues): Promise<void> {
  const secrets = secretFields(plugin.settings);
  await Promise.all(secrets.map((f) => saveSecret(plugin.meta.id, f, String(values[f] ?? ''))));
  const plain = Object.fromEntries(Object.entries(values).filter(([k]) => !secrets.includes(k)));
  useSettings.getState().setDeviceSettings(plugin.meta.id, plain);
}

/**
 * Selecting a device: save its settings, make it the active pump/CGM and restart the runtime.
 * Throws with the driver's message when the device could not be started.
 */
export async function activateDevice(kind: DeviceKind, plugin: Plugin, values: SettingsValues, entryId: string): Promise<void> {
  const errors = deviceErrors(plugin, values);
  if (errors.length) throw new Error(errors.join('\n'));
  await saveDeviceValues(plugin, values);
  useSettings.getState().update(kind === 'pump' ? { pumpId: plugin.meta.id } : { cgmId: plugin.meta.id });
  useDeviceUi.getState().setEntry(kind, entryId);
  await restartRuntime();
  const error = useRuntime.getState().deviceError;
  if (error) throw new Error(error);
}

/** "Delete Pump" / "Delete CGM": forget the device and restart without it. */
export async function deleteDevice(kind: DeviceKind): Promise<void> {
  if (kind === 'pump') await currentPump()?.disconnect().catch(() => undefined);
  useSettings.getState().update(kind === 'pump' ? { pumpId: '' } : { cgmId: '' });
  useDeviceUi.getState().setEntry(kind, null);
  await restartRuntime();
}

export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
