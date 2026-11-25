import { DatePicker, Host, Picker, Slider, Text } from '@expo/ui/swift-ui';
import { labelsHidden, pickerStyle, tag } from '@expo/ui/swift-ui/modifiers';
import { StyleSheet, View } from 'react-native';
import { useTrioColors } from '@/trio';

/** SwiftUI wheel picker height (Picker(.wheel) in a List row). */
const WHEEL_HEIGHT = 216;

export interface WheelOption {
  readonly value: number;
  readonly label: string;
}

/** SwiftUI `Picker(...).pickerStyle(WheelPickerStyle())`. */
export function Wheel({ value, options, onChange, label }: { value: number; options: readonly WheelOption[]; onChange: (v: number) => void; label: string }) {
  const c = useTrioColors();
  return (
    <Host style={styles.wheel} colorScheme={c.dark ? 'dark' : 'light'}>
      <Picker<number> label={label} selection={value} onSelectionChange={onChange} modifiers={[pickerStyle('wheel'), labelsHidden()]}>
        {options.map((o) => (
          <Text key={o.value} modifiers={[tag(o.value)]}>
            {o.label}
          </Text>
        ))}
      </Picker>
    </Host>
  );
}

/** Two or more wheels side by side (hours | minutes, from | to). */
export function WheelRow({ children }: { children: React.ReactNode }) {
  return <View style={styles.row}>{children}</View>;
}

/** SwiftUI compact `DatePicker(selection:in: Date.now...)` with date and time capsules. */
export function CompactDateTime({ value, min, onChange }: { value: number; min: number; onChange: (t: number) => void }) {
  const c = useTrioColors();
  return (
    <Host matchContents alignment="trailing" colorScheme={c.dark ? 'dark' : 'light'}>
      <DatePicker
        title="Start Time"
        selection={new Date(value)}
        range={{ start: new Date(min) }}
        displayedComponents={['date', 'hourAndMinute']}
        onDateChange={(d) => onChange(d.getTime())}
        modifiers={[labelsHidden()]}
      />
    </Host>
  );
}

/** SwiftUI `Slider(value:in:step:) minimumValueLabel / maximumValueLabel`. */
export function StepSlider({ value, min, max, step, minLabel, maxLabel, onChange, onEditingChanged }: { value: number; min: number; max: number; step: number; minLabel: string; maxLabel: string; onChange: (v: number) => void; onEditingChanged: (editing: boolean) => void }) {
  const c = useTrioColors();
  return (
    <Host matchContents={{ vertical: true }} style={{ flex: 1 }} colorScheme={c.dark ? 'dark' : 'light'} seedColor={c.tabBar}>
      <Slider value={value} min={min} max={max} step={step} onValueChange={onChange} onEditingChanged={onEditingChanged} minimumValueLabel={<Text>{minLabel}</Text>} maximumValueLabel={<Text>{maxLabel}</Text>} />
    </Host>
  );
}

const styles = StyleSheet.create({
  wheel: { flex: 1, height: WHEEL_HEIGHT },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12 },
});
