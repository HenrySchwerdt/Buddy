import * as Haptics from 'expo-haptics';
import { SymbolView } from '@/trio/symbol';
import { Pressable, StyleSheet, Switch, TextInput, View } from 'react-native';
import type { SettingField, SettingsSection, SettingsValues } from '@buddy/core';
import { useTheme } from '@/theme/use-theme';
import { radius, space } from '@/theme/tokens';
import { GlassPanel } from './glass-panel';
import { Text } from './text';

interface Props {
  readonly sections: readonly SettingsSection[];
  readonly values: SettingsValues;
  readonly onChange: (key: string, value: number | boolean | string) => void;
}

/**
 * Renders any plugin's declarative settings schema. Adding an algorithm or device
 * therefore needs zero UI code.
 */
export function SettingsForm({ sections, values, onChange }: Props) {
  return (
    <View style={{ gap: space.lg }}>
      {sections.map((section) => (
        <View key={section.title} style={{ gap: space.sm }}>
          <Text variant="overline" tone="faint" style={{ marginLeft: space.sm }}>
            {section.title}
          </Text>
          <GlassPanel padded={false}>
            {section.fields.map((field, i) => (
              <Field key={field.key} field={field} value={values[field.key]} onChange={onChange} last={i === section.fields.length - 1} />
            ))}
          </GlassPanel>
        </View>
      ))}
    </View>
  );
}

function Field({ field, value, onChange, last }: { field: SettingField; value: unknown; onChange: Props['onChange']; last: boolean }) {
  const theme = useTheme();
  return (
    <View style={[styles.field, !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.stroke }]}>
      <View style={styles.labelRow}>
        <View style={{ flex: 1, gap: 2 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text variant="body" style={{ fontWeight: '600' }}>
              {field.label}
            </Text>
            {'affectsDosing' in field && field.affectsDosing ? <SymbolView name="drop.fill" size={12} tintColor={theme.insulin} accessibilityLabel="Affects insulin dosing" /> : null}
          </View>
          {field.help ? (
            <Text variant="caption" tone="faint" style={{ fontWeight: '500' }}>
              {field.help}
            </Text>
          ) : null}
        </View>
        {field.kind === 'boolean' && (
          <Switch value={Boolean(value)} onValueChange={(v) => onChange(field.key, v)} trackColor={{ true: theme.accent }} accessibilityLabel={field.label} />
        )}
        {field.kind === 'number' && <Stepper field={field} value={Number(value)} onChange={(v) => onChange(field.key, v)} />}
      </View>
      {field.kind === 'select' && (
        <View style={styles.chips}>
          {field.options.map((o) => {
            const selected = o.value === value;
            return (
              <Pressable
                key={o.value}
                accessibilityRole="radio"
                accessibilityState={{ selected }}
                onPress={() => {
                  void Haptics.selectionAsync();
                  onChange(field.key, o.value);
                }}
                style={[styles.chip, { backgroundColor: selected ? theme.accent : theme.surface, borderColor: selected ? theme.accent : theme.stroke }]}>
                <Text variant="caption" color={selected ? '#fff' : theme.text}>
                  {o.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}
      {field.kind === 'text' && (
        <TextInput
          value={String(value ?? '')}
          onChangeText={(t) => onChange(field.key, t)}
          placeholder={field.placeholder}
          placeholderTextColor={theme.textFaint}
          secureTextEntry={field.secret}
          autoCapitalize="none"
          autoCorrect={false}
          style={[styles.input, { color: theme.text, backgroundColor: theme.surface, borderColor: theme.stroke }]}
          accessibilityLabel={field.label}
        />
      )}
    </View>
  );
}

function Stepper({ field, value, onChange }: { field: Extract<SettingField, { kind: 'number' }>; value: number; onChange: (v: number) => void }) {
  const theme = useTheme();
  const decimals = Math.max(0, -Math.floor(Math.log10(field.step)));
  const set = (v: number) => {
    const clamped = Math.min(field.max, Math.max(field.min, Math.round(v / field.step) * field.step));
    void Haptics.selectionAsync();
    onChange(Number(clamped.toFixed(decimals)));
  };
  const btn = (sym: 'minus' | 'plus', delta: number, disabled: boolean) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${sym === 'minus' ? 'Decrease' : 'Increase'} ${field.label}`}
      disabled={disabled}
      onPress={() => set(value + delta)}
      style={({ pressed }) => [styles.stepBtn, { backgroundColor: theme.surfaceStrong, opacity: disabled ? 0.3 : pressed ? 0.6 : 1 }]}>
      <SymbolView name={sym} size={14} tintColor={theme.text} weight="bold" />
    </Pressable>
  );
  return (
    <View style={styles.stepper} accessibilityLabel={`${field.label} ${value} ${field.unit ?? ''}`}>
      {btn('minus', -field.step, value <= field.min)}
      <View style={{ minWidth: 64, alignItems: 'center' }}>
        <Text variant="heading" style={{ fontVariant: ['tabular-nums'] }}>
          {value.toFixed(decimals)}
        </Text>
        {field.unit ? (
          <Text variant="caption" tone="faint">
            {field.unit}
          </Text>
        ) : null}
      </View>
      {btn('plus', field.step, value >= field.max)}
    </View>
  );
}

const styles = StyleSheet.create({
  field: { paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.sm },
  labelRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: { paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.sm, paddingHorizontal: space.md, paddingVertical: 10, fontSize: 15 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  stepBtn: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
});
