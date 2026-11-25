import { FIXED_NOTE, fixedBoolean, fixedDecimal, orefHasKey, useOrefBoolean, useOrefDecimal, useOrefPlugin } from '../bindings';
import type { PickerKey } from '../picker';
import { TRIO_COPY, type TrioCopyKey } from '../trio-copy';
import { SettingInputSection } from './setting-input-section';

const unavailableNote = (name: string) => `${name} does not use this setting.`;

/** Trio decimal setting backed by an oref plugin key. */
export function OrefDecimal({ copy, settingKey, picker, header }: { copy: TrioCopyKey; settingKey: string; picker: PickerKey; header?: string | null }) {
  const plugin = useOrefPlugin();
  const binding = useOrefDecimal(settingKey, picker);
  const supported = orefHasKey(plugin, settingKey);
  return <SettingInputSection copy={TRIO_COPY[copy]} decimal={binding} header={header} disabled={!supported} note={supported ? undefined : unavailableNote(plugin.meta.name)} />;
}

/** Trio toggle backed by an oref plugin key. */
export function OrefToggle({ copy, settingKey, header }: { copy: TrioCopyKey; settingKey: string; header?: string | null }) {
  const plugin = useOrefPlugin();
  const binding = useOrefBoolean(settingKey);
  const supported = orefHasKey(plugin, settingKey);
  return <SettingInputSection copy={TRIO_COPY[copy]} boolean={binding} header={header} disabled={!supported} note={supported ? undefined : unavailableNote(plugin.meta.name)} />;
}

/** Trio toggle that reveals a decimal, both backed by oref keys. */
export function OrefConditional({ copy, boolKey, decimalKey, picker }: { copy: TrioCopyKey; boolKey: string; decimalKey: string; picker: PickerKey }) {
  const plugin = useOrefPlugin();
  const bool = useOrefBoolean(boolKey);
  const dec = useOrefDecimal(decimalKey, picker);
  const supported = orefHasKey(plugin, boolKey);
  return <SettingInputSection copy={TRIO_COPY[copy]} boolean={bool} decimal={dec} disabled={!supported} note={supported ? undefined : unavailableNote(plugin.meta.name)} />;
}

/** Trio setting whose value Buddy's oref adapter hard-codes. */
export function FixedDecimal({ copy, value, picker, header }: { copy: TrioCopyKey; value: number; picker: PickerKey; header?: string | null }) {
  return <SettingInputSection copy={TRIO_COPY[copy]} decimal={fixedDecimal(value, picker)} header={header} disabled note={FIXED_NOTE} />;
}

export function FixedToggle({ copy, value, header }: { copy: TrioCopyKey; value: boolean; header?: string | null }) {
  return <SettingInputSection copy={TRIO_COPY[copy]} boolean={fixedBoolean(value)} header={header} disabled note={FIXED_NOTE} />;
}
