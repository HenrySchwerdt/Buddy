import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { T, useTrioColors } from '@/trio';
import { TREATMENT_TYPES, type TreatmentType } from './rows';

const ALL = TREATMENT_TYPES.length;

/** HistoryRootView+Filters.filterTreatmentsButton with its popover. */
export function TreatmentFilter({ selected, onChange }: { selected: ReadonlySet<TreatmentType>; onChange: (s: ReadonlySet<TreatmentType>) => void }) {
  const c = useTrioColors();
  const [open, setOpen] = useState(false);
  const allSelected = selected.size === ALL;
  const toggle = (t: TreatmentType) => {
    const next = new Set(selected);
    if (next.has(t)) next.delete(t);
    else next.add(t);
    onChange(next);
  };
  const check = (on: boolean) => <SymbolView name={on ? 'checkmark.square.fill' : 'square'} size={20} tintColor={c.tabBar} />;
  return (
    <>
      <Pressable onPress={() => setOpen(true)} accessibilityRole="button" accessibilityLabel="Filter" style={({ pressed }) => [styles.button, { opacity: pressed ? 0.5 : 1 }]}>
        <T color={c.tabBar}>Filter</T>
        <SymbolView name={allSelected ? 'line.3.horizontal.decrease.circle' : 'line.3.horizontal.decrease.circle.fill'} size={22} tintColor={c.tabBar} />
        {!allSelected ? <T color={c.tabBar}>{`(${selected.size}/${ALL})`}</T> : null}
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)} accessibilityLabel="Close filter">
          <Pressable style={[styles.popover, { backgroundColor: c.chart }]} onPress={() => undefined}>
            <Pressable onPress={() => onChange(allSelected ? new Set() : new Set(TREATMENT_TYPES.map((t) => t.value)))} style={styles.item} accessibilityRole="button">
              {check(allSelected)}
              <T>{allSelected ? 'Deselect All' : 'Select All'}</T>
            </Pressable>
            <View style={[styles.divider, { backgroundColor: c.separator }]} />
            {TREATMENT_TYPES.map((t) => (
              <Pressable key={t.value} onPress={() => toggle(t.value)} style={styles.item} accessibilityRole="checkbox" accessibilityState={{ checked: selected.has(t.value) }}>
                {check(selected.has(t.value))}
                <T>{t.label}</T>
              </Pressable>
            ))}
            <View style={[styles.divider, { backgroundColor: c.separator }]} />
            <Pressable onPress={() => setOpen(false)} accessibilityRole="button" style={{ alignItems: 'center', paddingTop: 4 }}>
              <T color={c.tabBar}>Done</T>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  button: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.25)', paddingTop: 300, paddingHorizontal: 24 },
  popover: { alignSelf: 'flex-start', minWidth: 240, borderRadius: 16, padding: 16, gap: 20 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 20, padding: 4 },
  divider: { height: StyleSheet.hairlineWidth },
});
