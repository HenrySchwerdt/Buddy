import { normalizeSettings, type AlgorithmPlugin, type SettingsValues } from '@buddy/core';
import { algorithms } from '@/runtime/runtime';
import { useSettings } from '@/runtime/settings-store';
import { PICKERS, intersectPicker, type PickerKey } from './picker';
import { useTreatmentSettings, type TreatmentSettings } from '@/features/treatment/settings-store';
import { useTrioPrefs, type TrioPrefKey, type TrioPrefs } from './store';
import type { BooleanBinding, DecimalBinding } from './components/setting-input-section';

const OREF_IDS: readonly string[] = ['oref-smb', 'oref-temp-basal'];

export const isOref = (id: string) => OREF_IDS.includes(id);

/** The oref plugin Trio's algorithm screens edit: the active one, else oref SMB. */
export function useOrefPlugin(): AlgorithmPlugin {
  const algorithmId = useSettings((s) => s.algorithmId);
  const id = isOref(algorithmId) ? algorithmId : 'oref-smb';
  return algorithms.require(id);
}

export function useOrefValues(): { plugin: AlgorithmPlugin; values: SettingsValues; set: (key: string, v: number | boolean) => void } {
  const plugin = useOrefPlugin();
  const stored = useSettings((s) => s.algorithmSettings[plugin.meta.id]);
  const setAlgorithmSettings = useSettings((s) => s.setAlgorithmSettings);
  const values = normalizeSettings(plugin.settings, plugin.defaultSettings, stored);
  return { plugin, values, set: (key, v) => setAlgorithmSettings(plugin.meta.id, { ...values, [key]: v }) };
}

/** Schema bounds of a numeric field, so pickers never offer values the plugin would clamp. */
function schemaBounds(plugin: AlgorithmPlugin, key: string): { min: number; max: number } | undefined {
  const field = plugin.settings.flatMap((s) => s.fields).find((f) => f.key === key);
  return field?.kind === 'number' ? { min: field.min, max: field.max } : undefined;
}

/** Whether the active oref plugin's schema exposes this key (temp-basal flavour has no SMB keys). */
export function orefHasKey(plugin: AlgorithmPlugin, key: string): boolean {
  return plugin.settings.some((s) => s.fields.some((f) => f.key === key));
}

export function useOrefDecimal(key: string, picker: PickerKey): DecimalBinding {
  const { plugin, values, set } = useOrefValues();
  return { value: Number(values[key] ?? 0), onChange: (v) => set(key, v), picker: intersectPicker(PICKERS[picker], schemaBounds(plugin, key)) };
}

export function useOrefBoolean(key: string): BooleanBinding {
  const { values, set } = useOrefValues();
  return { value: Boolean(values[key]), onChange: (v) => set(key, v) };
}

type NumericPref = { [K in TrioPrefKey]: TrioPrefs[K] extends number ? K : never }[TrioPrefKey];
type BooleanPref = { [K in TrioPrefKey]: TrioPrefs[K] extends boolean ? K : never }[TrioPrefKey];

export function usePrefDecimal(key: NumericPref, picker: PickerKey): DecimalBinding {
  const value = useTrioPrefs((s) => s[key]);
  const set = useTrioPrefs((s) => s.set);
  return { value, onChange: (v) => set({ [key]: v }), picker: PICKERS[picker] };
}

export function usePrefBoolean(key: BooleanPref): BooleanBinding {
  const value = useTrioPrefs((s) => s[key]);
  const set = useTrioPrefs((s) => s.set);
  return { value, onChange: (v) => set({ [key]: v }) };
}

type TreatmentNumber = { [K in keyof TreatmentSettings]: TreatmentSettings[K] extends number ? K : never }[keyof TreatmentSettings];
type TreatmentBoolean = { [K in keyof TreatmentSettings]: TreatmentSettings[K] extends boolean ? K : never }[keyof TreatmentSettings];

/** Meal / bolus-calculator settings owned by the Treatments feature store. */
export function useTreatmentDecimal(key: TreatmentNumber, picker: PickerKey): DecimalBinding {
  const value = useTreatmentSettings((s) => s[key]);
  const update = useTreatmentSettings((s) => s.update);
  return { value, onChange: (v) => update({ [key]: v }), picker: PICKERS[picker] };
}

export function useTreatmentBoolean(key: TreatmentBoolean): BooleanBinding {
  const value = useTreatmentSettings((s) => s[key]);
  const update = useTreatmentSettings((s) => s.update);
  return { value, onChange: (v) => update({ [key]: v }) };
}

/** Binding for a value Buddy's oref adapter hard-codes: shown, not editable. */
export function fixedDecimal(value: number, picker: PickerKey): DecimalBinding {
  return { value, onChange: () => undefined, picker: PICKERS[picker] };
}

export function fixedBoolean(value: boolean): BooleanBinding {
  return { value, onChange: () => undefined };
}

export const FIXED_NOTE = "Fixed in Buddy's oref adapter; this value is shown for reference and cannot be changed yet.";
export const NOT_USED_NOTE = 'Not used by Buddy yet. Saved for a future release; it does not change anything today.';
