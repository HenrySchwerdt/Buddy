import { Host, Picker, Text as SwiftText } from '@expo/ui/swift-ui';
import { pickerStyle, tag } from '@expo/ui/swift-ui/modifiers';
import { useState } from 'react';
import { Platform, View } from 'react-native';
import { Row, Section, T, useTrioColors } from '@/trio';

/**
 * AlarmBGSection / AlarmGramsSection: a value row that opens an inline wheel picker on tap.
 * `values` are the stored values; `format` renders them for display.
 */
export function ValueWheelSection({
  header,
  footer,
  title,
  value,
  values,
  unit,
  format,
  onChange,
}: {
  header: string;
  footer?: string;
  title: string;
  value: number;
  values: readonly number[];
  unit: string;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  const c = useTrioColors();
  const [open, setOpen] = useState(false);
  return (
    <Section header={header} footer={footer}>
      <View>
        <Row onPress={() => setOpen((o) => !o)} accessibilityLabel={`${title}, ${format(value)} ${unit}`}>
          <T style={{ flex: 1 }}>{title}</T>
          <T color={open ? c.accent : c.primary}>{format(value)}</T>
          <T secondary>{unit}</T>
        </Row>
        {open ? <Wheel title={title} value={value} values={values} format={format} onChange={onChange} /> : null}
      </View>
    </Section>
  );
}

function Wheel({ title, value, values, format, onChange }: { title: string; value: number; values: readonly number[]; format: (v: number) => string; onChange: (v: number) => void }) {
  const c = useTrioColors();
  if (Platform.OS !== 'ios') {
    // Fallback outside iOS: step buttons over the same value list.
    const i = Math.max(0, values.indexOf(value));
    return (
      <Row>
        <T color={c.tabBar} onPress={() => onChange(values[Math.max(0, i - 1)]!)} accessibilityRole="button">
          −
        </T>
        <T style={{ flex: 1 }} align="center">
          {format(value)}
        </T>
        <T color={c.tabBar} onPress={() => onChange(values[Math.min(values.length - 1, i + 1)]!)} accessibilityRole="button">
          +
        </T>
      </Row>
    );
  }
  return (
    <Host style={{ height: 216 }}>
      <Picker<number> label={title} selection={value} onSelectionChange={(v) => onChange(v)} modifiers={[pickerStyle('wheel')]}>
        {values.map((v) => (
          <SwiftText key={v} modifiers={[tag(v)]}>
            {format(v)}
          </SwiftText>
        ))}
      </Picker>
    </Host>
  );
}
