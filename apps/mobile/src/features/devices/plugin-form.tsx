import { useEffect, useState } from 'react';
import { StyleSheet, TextInput } from 'react-native';
import type { SettingField, SettingsSection, SettingsValues } from '@buddy/core';
import { PickerRow, Row, Section, T, ToggleRow, useTrioColors } from '@/trio';

/** Text entry row: label left, right-aligned field (SwiftUI `TextField` in an `HStack`). */
export function TextFieldRow({
  label,
  value,
  onChangeText,
  placeholder,
  secure,
  autoCapitalize = 'none',
  maxLength,
}: {
  label: string;
  value: string;
  onChangeText: (t: string) => void;
  placeholder?: string;
  secure?: boolean;
  autoCapitalize?: 'none' | 'characters';
  maxLength?: number;
}) {
  const c = useTrioColors();
  return (
    <Row>
      <T>{label}</T>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder ?? (secure ? 'Required' : '')}
        placeholderTextColor={c.tertiary}
        secureTextEntry={secure}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        maxLength={maxLength}
        selectionColor={c.tabBar}
        style={[styles.input, { color: c.primary }]}
        accessibilityLabel={label}
      />
    </Row>
  );
}

/** Numeric field that keeps the typed text and reports parsed numbers. */
function NumberFieldRow({ field, value, onChange }: { field: Extract<SettingField, { kind: 'number' }>; value: number; onChange: (v: number) => void }) {
  const c = useTrioColors();
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <Row>
      <T style={{ flex: 1 }}>{field.label}</T>
      <TextInput
        value={text}
        onChangeText={(t) => {
          setText(t);
          const n = Number(t.replace(',', '.'));
          if (t.trim() !== '' && Number.isFinite(n)) onChange(n);
        }}
        keyboardType="decimal-pad"
        selectionColor={c.tabBar}
        style={[styles.input, { color: field.affectsDosing ? c.orange : c.primary, flex: 0, minWidth: 60 }]}
        accessibilityLabel={field.label}
      />
      {field.unit ? <T secondary>{field.unit}</T> : null}
    </Row>
  );
}

function FieldRow({ field, values, onChange }: { field: SettingField; values: SettingsValues; onChange: (key: string, v: string | number | boolean) => void }) {
  const v = values[field.key];
  switch (field.kind) {
    case 'boolean':
      return <ToggleRow label={field.label} value={v === true} onChange={(x) => onChange(field.key, x)} />;
    case 'select':
      return <PickerRow label={field.label} value={String(v ?? '')} options={field.options} onChange={(x) => onChange(field.key, x)} />;
    case 'number':
      return <NumberFieldRow field={field} value={typeof v === 'number' ? v : field.min} onChange={(x) => onChange(field.key, x)} />;
    case 'text':
      return <TextFieldRow label={field.label} value={String(v ?? '')} placeholder={field.placeholder} secure={field.secret} onChangeText={(x) => onChange(field.key, x)} />;
  }
}

const footerFor = (fields: readonly SettingField[]) => {
  const lines = fields.filter((f) => f.help).map((f) => (fields.length > 1 ? `${f.label}: ${f.help}` : f.help!));
  return lines.length ? lines.join('\n') : undefined;
};

/**
 * Renders a plugin's declarative settings with the Trio list rows. `keys` limits the form to
 * some fields (setup steps show one question at a time, like the driver onboarding in Trio).
 */
export function PluginForm({
  sections,
  values,
  onChange,
  keys,
  headers = true,
}: {
  sections: readonly SettingsSection[];
  values: SettingsValues;
  onChange: (key: string, v: string | number | boolean) => void;
  keys?: readonly string[];
  headers?: boolean;
}) {
  return (
    <>
      {sections.map((s) => {
        const fields = s.fields.filter((f) => !keys || keys.includes(f.key));
        if (!fields.length) return null;
        return (
          <Section key={s.title} header={headers ? s.title : undefined} footer={footerFor(fields)}>
            {fields.map((f) => (
              <FieldRow key={f.key} field={f} values={values} onChange={onChange} />
            ))}
          </Section>
        );
      })}
    </>
  );
}

const styles = StyleSheet.create({
  input: { flex: 1, textAlign: 'right', fontSize: 17, paddingVertical: 0 },
});
