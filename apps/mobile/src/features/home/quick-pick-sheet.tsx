import { useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, View } from 'react-native';
import { SymbolView } from '@/trio/symbol';
import { SheetModal } from '@/trio/sheet-modal';
import { BusyOverlay } from '@/features/treatment/treatment-button';
import { T, useTrioColors } from '@/trio';
import { displayedSuggestions, outcomeAlert, slideLabel, type OutcomeAlert } from './quick-pick';
import { enactQuickPick, useQuickPick } from './quick-pick-store';
import { SlideToConfirm } from './slide-to-confirm';

const INFO = 'Quick-Pick Treatments looks at your manual boluses and carb entries from the past 90 days and suggests the amounts you most commonly enter at this time of day.\n\nIt gives more weight to entries from similar times of day, and treats weekdays and weekends separately. Older entries gradually count less.\n\nTap a bolus amount, a carb amount, or both, then slide to confirm.\n\nFor calculator or recommendations, use the Treatments View.';

function Pill({ amount, unit, selected, accent, onPress, spoken }: { amount: number; unit: string; selected: boolean; accent: string; onPress: () => void; spoken: string }) {
  const c = useTrioColors();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityState={{ selected }} accessibilityLabel={`${amount} ${spoken}`} style={[styles.pill, { backgroundColor: selected ? accent : c.fill, borderColor: accent, borderWidth: selected ? 2.5 : 0 }]}>
      <T style_="title2" weight="700" color={selected ? '#FFFFFF' : c.primary} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
        {amount}
        <T style_="title2" weight="400" color={selected ? 'rgba(255,255,255,0.85)' : c.secondary}>
          {unit}
        </T>
      </T>
    </Pressable>
  );
}

function PillRow({ amounts, selected, accent, unit, spoken, onSelect }: { amounts: readonly number[]; selected: number | null; accent: string; unit: string; spoken: string; onSelect: (a: number) => void }) {
  const compact = amounts.length < 2;
  return (
    <View style={[styles.row, compact && { justifyContent: 'center' }]}>
      {amounts.map((a) => (
        <View key={a} style={compact ? { width: 160 } : { flex: 1 }}>
          <Pill amount={a} unit={unit} selected={selected === a} accent={accent} spoken={spoken} onPress={() => onSelect(a)} />
        </View>
      ))}
    </View>
  );
}

/** QuickPickTreatmentsView: carb and bolus pills, slide to log and enact; mounted once next to the treatment button. */
export function QuickPickHost() {
  const picker = useQuickPick((s) => s.picker);
  const noHistory = useQuickPick((s) => s.noHistory);
  const close = useQuickPick((s) => s.close);
  useEffect(() => {
    if (!noHistory) return;
    Alert.alert('No treatment history yet', "Quick-Pick Treatments learns from your manual boluses and carb entries over time. Once you've logged a few, it will suggest amounts based on what you typically enter at this time of day.", [{ text: 'OK', onPress: close }]);
  }, [noHistory, close]);
  return picker ? <QuickPickSheet onClosed={close} /> : null;
}

function QuickPickSheet({ onClosed }: { onClosed: () => void }) {
  const c = useTrioColors();
  const bolusAll = useQuickPick((s) => s.bolus);
  const carbsAll = useQuickPick((s) => s.carbs);
  const bolusAmounts = displayedSuggestions(bolusAll);
  const carbAmounts = displayedSuggestions(carbsAll);
  const [bolus, setBolus] = useState<number | null>(null);
  const [carbs, setCarbs] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [alert, setAlert] = useState<OutcomeAlert | null>(null);
  const toggle = (cur: number | null, set: (v: number | null) => void) => (a: number) => set(cur === a ? null : a);

  const progress = bolus !== null && carbs !== null ? 'Updating IOB and COB...' : carbs !== null ? 'Updating COB...' : bolus !== null ? 'Updating IOB...' : 'Updating Treatments...';
  const enact = async (dismiss: (after?: () => void) => void) => {
    if ((bolus === null && carbs === null) || busy) return;
    setBusy(true);
    const outcome = await enactQuickPick(bolus, carbs);
    setBusy(false);
    const a = outcomeAlert(outcome);
    if (!a) return dismiss();
    setAlert(a);
    Alert.alert(a.title, a.message, [{ text: 'Got it!', onPress: () => (a.dismissesSheet ? dismiss() : setAlert(null)) }]);
  };

  return (
    <SheetModal onClosed={onClosed} dismissable={!busy && !alert}>
      {(dismiss) => (
        <View style={[styles.sheet, { backgroundColor: c.dark ? '#1C1C1E' : '#F2F2F7' }]}>
          <View style={styles.header}>
            <View style={{ width: 28 }} />
            <T style_="title3" weight="700" style={{ flex: 1, textAlign: 'center' }}>
              Quick-Pick Treatments
            </T>
            <Pressable onPress={() => Alert.alert('About Quick-Pick Treatments', INFO, [{ text: 'Got it!' }])} accessibilityRole="button" accessibilityLabel="More information" hitSlop={8}>
              <SymbolView name="questionmark.circle" size={24} tintColor={c.accent} />
            </Pressable>
          </View>
          <View style={[busy && { opacity: 0.4 }, { gap: 12 }]} pointerEvents={busy ? 'none' : 'auto'}>
            {carbAmounts.length > 0 ? <PillRow amounts={carbAmounts} selected={carbs} accent={c.orange} unit=" g" spoken="grams" onSelect={toggle(carbs, setCarbs)} /> : null}
            {bolusAmounts.length > 0 ? <PillRow amounts={bolusAmounts} selected={bolus} accent={c.accent} unit=" U" spoken="units" onSelect={toggle(bolus, setBolus)} /> : null}
            <T style_="subheadline" secondary style={{ padding: 8 }}>
              Your most-used amounts at similar times on similar days. Tap a bolus, a carb amount, or both.
            </T>
            <SlideToConfirm label={slideLabel(bolus, carbs)} disabled={bolus === null && carbs === null} onConfirm={() => void enact(dismiss)} />
          </View>
          {busy ? <BusyOverlay text={progress} /> : null}
        </View>
      )}
    </SheetModal>
  );
}

const styles = StyleSheet.create({
  sheet: { borderRadius: 28, padding: 16, gap: 16, overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center' },
  row: { flexDirection: 'row', gap: 16 },
  pill: { minHeight: 44, borderRadius: 18, borderCurve: 'continuous', alignItems: 'center', justifyContent: 'center', paddingVertical: 12, paddingHorizontal: 12 },
});
