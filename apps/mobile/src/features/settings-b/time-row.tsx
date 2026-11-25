import { DatePicker, Host } from '@expo/ui/swift-ui';
import { datePickerStyle, labelsHidden } from '@expo/ui/swift-ui/modifiers';
import { SymbolView, type SFSymbol } from '@/trio/symbol';
import { Platform, View } from 'react-native';
import { PickerRow, Row, T } from '@/trio';

const HALF_HOURS = Array.from({ length: 48 }, (_, i) => ({ value: i * 30, label: formatMinuteOfDay(i * 30) }));

export function formatMinuteOfDay(m: number): string {
  const d = new Date(2000, 0, 1, Math.floor(m / 60), m % 60);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** `DatePicker(displayedComponents: .hourAndMinute)` row with an SF Symbol label. */
export function TimeOfDayRow({ label, icon, iconColor, minute, onChange }: { label: string; icon: SFSymbol; iconColor: string; minute: number; onChange: (m: number) => void }) {
  if (Platform.OS !== 'ios') {
    return <PickerRow label={label} value={minute - (minute % 30)} options={HALF_HOURS} onChange={onChange} />;
  }
  const selection = new Date(2000, 0, 1, Math.floor(minute / 60), minute % 60);
  return (
    <Row accessibilityLabel={`${label}, ${formatMinuteOfDay(minute)}`}>
      <SymbolView name={icon} size={20} tintColor={iconColor} />
      <T style={{ flex: 1 }}>{label}</T>
      <View>
        <Host matchContents alignment="trailing">
          <DatePicker
            title={label}
            selection={selection}
            displayedComponents={['hourAndMinute']}
            onDateChange={(d) => onChange(d.getHours() * 60 + d.getMinutes())}
            modifiers={[datePickerStyle('compact'), labelsHidden()]}
          />
        </Host>
      </View>
    </Row>
  );
}
