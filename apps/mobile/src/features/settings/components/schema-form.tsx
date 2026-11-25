import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import type { SettingField, SettingsSection, SettingsValues } from '@buddy/core';
import { InputRow, PickerRow, Section, T, ToggleRow, useTrioColors } from '@/trio';
import { closestIndex, fmtDecimal } from '../picker';
import { WheelPicker } from './wheel-picker';

/**
 * Renders a plugin's declarative settings schema with the Trio UI kit, so any algorithm
 * added to Buddy gets a settings screen without UI code.
 */
export function SchemaForm({ sections, values, onChange }: { sections: readonly SettingsSection[]; values: SettingsValues; onChange: (key: string, v: number | boolean | string) => void }) {
  return (
    <>
      {sections.map((section) => (
        <Section key={section.title} header={section.title}>
          {section.fields.map((f) => (
            <FieldRow key={f.key} field={f} value={values[f.key]} onChange={(v) => onChange(f.key, v)} />
          ))}
        </Section>
      ))}
    </>
  );
}

function FieldRow({ field, value, onChange }: { field: SettingField; value: number | boolean | string | undefined; onChange: (v: number | boolean | string) => void }) {
  switch (field.kind) {
    case 'boolean':
      return <ToggleRow label={field.label} subtitle={field.help} value={Boolean(value)} onChange={onChange} />;
    case 'select':
      return <PickerRow label={field.label} value={String(value)} options={field.options} onChange={onChange} />;
    case 'text':
      return <InputRow label={field.label} value={String(value ?? '')} onChangeText={onChange} keyboardType="default" placeholder={field.placeholder ?? ''} />;
    case 'number':
      return <NumberField field={field} value={Number(value ?? field.min)} onChange={onChange} />;
  }
}

function NumberField({ field, value, onChange }: { field: Extract<SettingField, { kind: 'number' }>; value: number; onChange: (v: number) => void }) {
  const c = useTrioColors();
  const [open, setOpen] = useState(false);
  const options = useMemo(() => {
    const n = Math.round((field.max - field.min) / field.step);
    return Array.from({ length: n + 1 }, (_, i) => Math.round((field.min + i * field.step) * 1e4) / 1e4);
  }, [field.min, field.max, field.step]);
  const fmt = (v: number) => `${fmtDecimal(v)}${field.unit ? ` ${field.unit}` : ''}`;
  return (
    <View>
      <Pressable onPress={() => setOpen((o) => !o)} accessibilityRole="button" accessibilityLabel={field.label} accessibilityValue={{ text: fmt(value) }} style={styles.row}>
        <View style={{ flex: 1 }}>
          <T>{field.label}</T>
          {field.help ? (
            <T style_="footnote" secondary>
              {field.help}
            </T>
          ) : null}
        </View>
        <T color={open ? c.accent : field.affectsDosing ? c.orange : c.primary}>{fmt(value)}</T>
      </Pressable>
      {open ? <WheelPicker count={options.length} index={closestIndex(options, value)} label={(i) => fmt(options[i]!)} onChange={(i) => onChange(options[i]!)} accessibilityLabel={field.label} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingVertical: 12 },
});
