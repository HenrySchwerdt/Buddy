import * as Haptics from 'expo-haptics';
import { SymbolView } from '@/trio/symbol';
import { Fragment, useState } from 'react';
import { ActionSheetIOS, Alert, Platform, Pressable, StyleSheet, View } from 'react-native';
import { TIME_VALUES, addItem, cannotAddMore, fmtClock, type TherapyItem } from './logic';
import { OB, OT } from './theme';
import { WheelPicker } from './wheel';

interface Props {
  readonly items: readonly TherapyItem[];
  readonly onChange: (items: TherapyItem[]) => void;
  readonly options: readonly number[];
  readonly format: (v: number) => string;
  /** `TherapySettingUnit.displayName` ("U/hr", "g/U", "mg/dL", …). */
  readonly unit: string;
}

/** Port of Trio's `TherapySettingEditorView`: "Entries" header with Add, rows with inline value/time wheels. */
export function TherapySettingEditor({ items, onChange, options, format, unit }: Props) {
  const [selected, setSelected] = useState<string | null>(null);
  const disabled = cannotAddMore(items);

  const confirmDelete = (item: TherapyItem) => {
    if (items.length <= 1) return;
    const remove = () => {
      setSelected(null);
      onChange(items.filter((i) => i.id !== item.id));
    };
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions({ options: ['Delete', 'Cancel'], destructiveButtonIndex: 0, cancelButtonIndex: 1 }, (i) => i === 0 && remove());
    } else {
      Alert.alert('Delete', undefined, [{ text: 'Delete', style: 'destructive', onPress: remove }, { text: 'Cancel', style: 'cancel' }]);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <OT weight="700">Entries</OT>
        <Pressable
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel="Add"
          onPress={() => {
            setSelected(null);
            onChange(addItem(items));
          }}
          style={({ pressed }) => [styles.add, pressed && { opacity: 0.6 }]}>
          <SymbolView name="plus.circle.fill" size={20} tintColor={disabled ? OB.secondary : OB.blue} />
          <OT color={disabled ? OB.secondary : OB.blue}>Add</OT>
        </Pressable>
      </View>
      {items.map((item, index) => {
        const isOpen = selected === item.id;
        return (
          <Fragment key={item.id}>
            <Pressable
              onPress={() => {
                void Haptics.selectionAsync();
                setSelected(isOpen ? null : item.id);
              }}
              onLongPress={() => confirmDelete(item)}
              accessibilityRole="button"
              accessibilityLabel={`${format(item.value)} ${unit}, starts at ${fmtClock(item.time)}`}
              accessibilityHint="Opens a picker to edit this entry"
              accessibilityActions={items.length > 1 ? [{ name: 'delete', label: 'Delete' }] : []}
              onAccessibilityAction={(e) => e.nativeEvent.actionName === 'delete' && confirmDelete(item)}
              style={styles.row}>
              <OT color={isOpen ? OB.blue : OB.primary}>{format(item.value)}</OT>
              <OT secondary style={{ flex: 1 }}>
                {unit}
              </OT>
              <OT secondary>starts at</OT>
              <OT color={isOpen ? OB.blue : OB.primary}>{fmtClock(item.time)}</OT>
            </Pressable>
            {isOpen ? <EntryPicker item={item} isFirst={index === 0} items={items} options={options} format={format} unit={unit} onChange={onChange} /> : null}
            {index < items.length - 1 ? <View style={styles.separator} /> : null}
          </Fragment>
        );
      })}
      <View style={styles.footer} />
    </View>
  );
}

function EntryPicker({ item, isFirst, items, options, format, unit, onChange }: { item: TherapyItem; isFirst: boolean } & Omit<Props, 'items'> & { items: readonly TherapyItem[] }) {
  const taken = new Set(items.filter((i) => i.id !== item.id).map((i) => i.time));
  const times = TIME_VALUES.filter((t) => t === item.time || !taken.has(t));
  const replace = (patch: Partial<TherapyItem>) => onChange(items.map((i) => (i.id === item.id ? { ...i, ...patch } : i)));
  return (
    <View style={styles.pickers}>
      <View style={{ flex: 1 }}>
        <WheelPicker label="Value" options={options} value={item.value} format={(v) => `${format(v)} ${unit}`} onChange={(value) => replace({ value })} />
      </View>
      <View style={{ flex: 1 }}>
        <WheelPicker label="Time" options={times} value={item.time} format={fmtClock} onChange={(time) => replace({ time })} disabled={isFirst} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { backgroundColor: OB.card, borderBottomLeftRadius: 10, borderBottomRightRadius: 10 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 10, paddingLeft: 20, paddingRight: 20, marginTop: 8 },
  add: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 45, paddingHorizontal: 16, backgroundColor: 'rgba(33,33,46,0.35)' },
  pickers: { flexDirection: 'row', paddingVertical: 8, paddingHorizontal: 8 },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: OB.separator, marginLeft: 16 },
  footer: { height: 10 },
});
