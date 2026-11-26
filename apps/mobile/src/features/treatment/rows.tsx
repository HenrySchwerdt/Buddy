import * as Haptics from 'expo-haptics';
import { SymbolView } from '@/trio/symbol';
import { Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { Host, DatePicker } from '@expo/ui/swift-ui';
import { DateTimeCapsules } from '@/trio/android-pickers';
import { controlSize, labelsHidden } from '@expo/ui/swift-ui/modifiers';
import { Row, T, useTrioColors } from '@/trio';
import { bolusAmountFormatter } from './formatting';

const FIFTEEN_MIN = 15 * 60_000;

/** iOS systemBlue (Trio). */
export const SYSTEM_BLUE = '#0A84FF';
const LIGHT_BLUE = '#007AFF';

/** Digits only, at most `max` characters (Trio's mealFormatter: integers, 3 digits). */
export const sanitizeInteger = (t: string, max = 3) => t.replace(/[^0-9]/g, '').slice(0, max);
/** Decimal input with either separator. */
export const sanitizeDecimal = (t: string) => t.replace(/[^0-9.,]/g, '').replace(/([.,].*)[.,]/, '$1');

function Field({ value, onChangeText, unit, keyboardType, maxLength, color, label }: { value: string; onChangeText: (t: string) => void; unit: string; keyboardType: 'number-pad' | 'decimal-pad'; maxLength: number; color?: string; label: string }) {
  const c = useTrioColors();
  return (
    <View style={styles.field}>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder="0"
        placeholderTextColor={c.tertiary}
        keyboardType={keyboardType}
        maxLength={maxLength}
        selectionColor={c.tabBar}
        style={[styles.input, { color: color ?? c.primary }]}
        accessibilityLabel={label}
      />
      <T secondary>{unit}</T>
    </View>
  );
}

/** "Fat [0 g] | Protein [0 g]" — one row like Trio's `proteinAndFat()`. */
export function FatProteinRow({ fat, protein, onFat, onProtein }: { fat: string; protein: string; onFat: (t: string) => void; onProtein: (t: string) => void }) {
  const c = useTrioColors();
  return (
    <Row>
      <T>Fat</T>
      <Field value={fat} onChangeText={(t) => onFat(sanitizeInteger(t))} unit="g" keyboardType="number-pad" maxLength={3} label="Fat" />
      <View style={[styles.vDivider, { backgroundColor: c.separator }]} />
      <T>Protein</T>
      <Field value={protein} onChangeText={(t) => onProtein(sanitizeInteger(t))} unit="g" keyboardType="number-pad" maxLength={3} label="Protein" />
    </Row>
  );
}

/** Time row: "Now" until tapped, then − [time picker] + in 15-minute steps. */
export function TimeRow({ date, pushed, onPush, onChange }: { date: number; pushed: boolean; onPush: () => void; onChange: (d: number) => void }) {
  const c = useTrioColors();
  return (
    <Row>
      <SymbolView name="clock" size={22} tintColor={c.primary} />
      <View style={{ flex: 1 }} />
      {!pushed ? (
        <Pressable onPress={onPush} accessibilityRole="button" hitSlop={8} style={{ paddingRight: 5 }}>
          <T secondary>Now</T>
        </Pressable>
      ) : (
        <>
          <Pressable onPress={() => onChange(date - FIFTEEN_MIN)} accessibilityRole="button" accessibilityLabel="15 minutes earlier" hitSlop={6}>
            <SymbolView name="minus.circle" size={22} tintColor={SYSTEM_BLUE} />
          </Pressable>
          {Platform.OS === 'ios' ? (
            <Host matchContents>
              <DatePicker selection={new Date(date)} displayedComponents={['hourAndMinute']} onDateChange={(d) => onChange(d.getTime())} modifiers={[labelsHidden(), controlSize('mini')]} />
            </Host>
          ) : (
            <DateTimeCapsules value={date} onChange={onChange} date={false} />
          )}
          <Pressable onPress={() => onChange(date + FIFTEEN_MIN)} accessibilityRole="button" accessibilityLabel="15 minutes later" hitSlop={6}>
            <SymbolView name="plus.circle" size={22} tintColor={SYSTEM_BLUE} />
          </Pressable>
        </>
      )}
    </Row>
  );
}

/** Reduced Bolus / Super Bolus radio toggles (`RadioButtonToggleStyle`, footnote). */
export function BolusOptionsRow({ fattyMeals, sweetMeals, fatty, superBolus, onFatty, onSuper }: { fattyMeals: boolean; sweetMeals: boolean; fatty: boolean; superBolus: boolean; onFatty: (v: boolean) => void; onSuper: (v: boolean) => void }) {
  return (
    <Row style={{ gap: 10 }}>
      {fattyMeals ? <Radio label="Reduced Bolus" value={fatty} onChange={onFatty} /> : null}
      {sweetMeals ? <Radio label="Super Bolus" value={superBolus} onChange={onSuper} /> : null}
    </Row>
  );
}

function Radio({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  const c = useTrioColors();
  return (
    <Pressable
      onPress={() => {
        void Haptics.selectionAsync();
        onChange(!value);
      }}
      accessibilityRole="radio"
      accessibilityState={{ checked: value }}
      style={styles.radio}>
      <SymbolView name={value ? 'largecircle.fill.circle' : 'circle'} size={20} tintColor={value ? SYSTEM_BLUE : c.secondary} />
      <T style_="footnote">{label}</T>
    </Pressable>
  );
}

/** "Recommendation ⓘ   [0,2 U]" — the bordered button copies the recommendation into Bolus. */
export function RecommendationRow({ value, disabled, onInfo, onUse }: { value: number; disabled: boolean; onInfo: () => void; onUse: () => void }) {
  const c = useTrioColors();
  const text = bolusAmountFormatter(value);
  return (
    <Row>
      <T>Recommendation</T>
      <Pressable onPress={onInfo} accessibilityRole="button" accessibilityLabel="About the recommendation" hitSlop={8}>
        <SymbolView name="info.circle" size={22} tintColor={SYSTEM_BLUE} />
      </Pressable>
      <View style={{ flex: 1 }} />
      <Pressable
        disabled={disabled}
        onPress={() => {
          void Haptics.selectionAsync();
          onUse();
        }}
        accessibilityRole="button"
        accessibilityLabel={`Use recommended bolus, ${text} units`}
        accessibilityHint="Copies the recommended amount into the bolus field"
        accessibilityState={{ disabled }}
        style={({ pressed }) => [styles.bordered, { backgroundColor: c.fill, marginRight: -10, opacity: pressed ? 0.6 : 1 }]}>
        <T color={disabled ? c.tertiary : c.dark ? SYSTEM_BLUE : LIGHT_BLUE}>{text}</T>
        <T secondary> U</T>
      </Pressable>
    </Row>
  );
}

/** Bolus entry; text is white in dark mode and blue in light mode like Trio. */
export function BolusRow({ value, onChangeText }: { value: string; onChangeText: (t: string) => void }) {
  const c = useTrioColors();
  return (
    <Row>
      <T style={{ flex: 1 }}>Bolus</T>
      <Field value={value} onChangeText={(t) => onChangeText(sanitizeDecimal(t))} unit="U" keyboardType="decimal-pad" maxLength={5} color={c.dark ? '#FFFFFF' : LIGHT_BLUE} label="Bolus" />
    </Row>
  );
}

const styles = StyleSheet.create({
  field: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 8 },
  input: { minWidth: 40, textAlign: 'right', fontSize: 17, paddingVertical: 0 },
  vDivider: { width: StyleSheet.hairlineWidth * 2, alignSelf: 'stretch', marginHorizontal: 4 },
  radio: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  bordered: { flexDirection: 'row', alignItems: 'baseline', borderRadius: 999, paddingHorizontal: 14, paddingVertical: 7 },
});
