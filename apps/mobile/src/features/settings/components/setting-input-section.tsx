import { SymbolView } from '@/trio/symbol';
import { useMemo, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Switch, View } from 'react-native';
import { Section, T, useTrioColors } from '@/trio';
import { useSettings } from '@/runtime/settings-store';
import { resolveCopy } from '../copy';
import { closestIndex, fmtPickerValue, pickerValues } from '../picker';
import type { PickerSetting, TrioSettingCopy } from '../types';
import { useShowHint } from './hint-sheet';
import { WheelPicker } from './wheel-picker';

export interface DecimalBinding {
  readonly value: number;
  readonly onChange: (v: number) => void;
  readonly picker: PickerSetting;
}

export interface BooleanBinding {
  readonly value: boolean;
  readonly onChange: (v: boolean) => void;
}

interface Props {
  readonly copy: TrioSettingCopy;
  readonly decimal?: DecimalBinding;
  readonly boolean?: BooleanBinding;
  /** Overrides the copy's header (pass null to hide it). */
  readonly header?: string | null;
  readonly footer?: string;
  readonly miniHint?: string;
  readonly miniHintColor?: string;
  /** Read-only: Buddy does not (yet) let this setting change dosing. */
  readonly disabled?: boolean;
  /** Extra line under the mini hint (e.g. why a setting is fixed in Buddy). */
  readonly note?: string;
}

/**
 * Port of Trio's `SettingInputSection`: one list section with a value row (tap opens a
 * wheel picker), a toggle, or a toggle that reveals a value row, plus a mini hint and a
 * "?" button that opens the Help sheet.
 */
export function SettingInputSection({ copy, decimal, boolean, header, footer, miniHint, miniHintColor, disabled, note }: Props) {
  const c = useTrioColors();
  const units = useSettings((s) => s.units);
  const showHint = useShowHint();
  const label = resolveCopy(copy.label, units);
  const headerText = header === null ? undefined : (header ?? (copy.header ? resolveCopy(copy.header, units) : undefined));

  return (
    <Section header={headerText} footer={footer}>
      <View style={[styles.body, disabled && { opacity: 0.6 }]} pointerEvents={disabled ? 'box-none' : 'auto'}>
        {boolean ? <ToggleLine label={label} binding={boolean} disabled={disabled} /> : null}
        {decimal && (!boolean || boolean.value) ? (
          <DecimalLine label={boolean && copy.conditionalLabel ? resolveCopy(copy.conditionalLabel, units) : label} binding={decimal} disabled={disabled} />
        ) : null}
        <View style={styles.hintRow}>
          <View style={{ flex: 1, gap: 6 }}>
            <T style_="footnote" color={miniHintColor ?? c.secondary}>
              {miniHint ?? resolveCopy(copy.miniHint, units)}
            </T>
            {note ? (
              <T style_="footnote" color={c.orange}>
                {note}
              </T>
            ) : null}
          </View>
          <HintButton label={label} onPress={() => showHint({ label: copy.label, lines: copy.hint })} />
        </View>
      </View>
    </Section>
  );
}

export function HintButton({ label, onPress }: { label: string; onPress: () => void }) {
  const c = useTrioColors();
  return (
    <Pressable onPress={onPress} hitSlop={10} accessibilityRole="button" accessibilityLabel={`More information about ${label}`} style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}>
      <SymbolView name="questionmark.circle" size={24} tintColor={c.tabBar} />
    </Pressable>
  );
}

function ToggleLine({ label, binding, disabled }: { label: string; binding: BooleanBinding; disabled?: boolean }) {
  const c = useTrioColors();
  return (
    <View style={styles.line}>
      <T style={{ flex: 1 }}>{label}</T>
      <Switch value={binding.value} disabled={disabled} onValueChange={binding.onChange} trackColor={{ true: c.green }} accessibilityLabel={label} />
    </View>
  );
}

/** Value row that opens a wheel picker on tap (Trio's pickerView). */
export function DecimalLine({ label, binding, disabled }: { label: string; binding: DecimalBinding; disabled?: boolean }) {
  const c = useTrioColors();
  const units = useSettings((s) => s.units);
  const [open, setOpen] = useState(false);
  const values = useMemo(() => pickerValues(binding.picker, units), [binding.picker, units]);
  const index = closestIndex(values, binding.value);
  const text = fmtPickerValue(binding.picker.kind, binding.value, units);
  return (
    <View>
      <Pressable
        disabled={disabled}
        onPress={() => setOpen((o) => !o)}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityValue={{ text }}
        accessibilityHint={open ? 'Closes the value picker' : 'Opens a picker to change the value'}
        style={styles.line}>
        <T style={{ flex: 1 }}>{label}</T>
        <T color={open ? c.accent : c.primary}>{text}</T>
      </Pressable>
      {open ? (
        <WheelPicker
          count={values.length}
          index={index}
          label={(i) => fmtPickerValue(binding.picker.kind, values[i]!, units)}
          onChange={(i) => binding.onChange(values[i]!)}
          accessibilityLabel={label}
        />
      ) : null}
    </View>
  );
}

/** Section with a free-form body and Trio's mini-hint + "?" row (Pickers in Trio's views). */
export function HintedSection({ header, children, miniHint, miniHintColor, hint, footer }: { header?: string; children: ReactNode; miniHint: string; miniHintColor?: string; hint: { label: string; lines: readonly string[] }; footer?: string }) {
  const c = useTrioColors();
  const units = useSettings((s) => s.units);
  const showHint = useShowHint();
  return (
    <Section header={header} footer={footer}>
      <View style={styles.body}>
        {children}
        <View style={styles.hintRow}>
          <T style_="footnote" color={miniHintColor ?? c.secondary} style={{ flex: 1 }}>
            {resolveCopy(miniHint, units)}
          </T>
          <HintButton label={hint.label} onPress={() => showHint(hint)} />
        </View>
      </View>
    </Section>
  );
}

const styles = StyleSheet.create({
  body: { paddingTop: 4 },
  line: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 12, paddingTop: 8, paddingHorizontal: 20 },
  hintRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 16, paddingHorizontal: 20 },
});
