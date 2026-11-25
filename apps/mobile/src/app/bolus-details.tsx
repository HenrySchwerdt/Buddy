import { router } from 'expo-router';
import { SymbolView } from '@/trio/symbol';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { T, useTrioColors } from '@/trio';
import { CalculationCards } from '@/features/treatment/details-cards';
import { useSheetSurfaces } from '@/features/treatment/formula';
import { insulinFormatter, isRoundedForPump, recommendationWarning, type RecommendationCardInput } from '@/features/treatment/formatting';
import { useTreatmentModel, type TreatmentModel } from '@/features/treatment/use-treatment-model';

/** Port of Trio's `PopupView` ("Bolus Calculator Details"). */
export default function BolusDetailsSheet() {
  const m = useTreatmentModel();
  const s = useSheetSurfaces();
  const c = useTrioColors();
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, backgroundColor: s.background }}>
      <T style_="headline" align="center" style={styles.title} accessibilityRole="header">
        Bolus Calculator Details
      </T>
      <ScrollView contentContainerStyle={styles.list} indicatorStyle={c.dark ? 'white' : 'black'}>
        <CalculationCards m={m} />
      </ScrollView>
      <View style={[styles.footer, { paddingBottom: insets.bottom + 8 }]}>
        <RecommendedBolusCard m={m} />
        <Pressable onPress={() => router.back()} accessibilityRole="button" style={({ pressed }) => [styles.gotIt, { backgroundColor: c.fill, opacity: pressed ? 0.6 : 1 }]}>
          <T style_="headline" weight="700" color={c.accent}>
            Got it!
          </T>
        </Pressable>
      </View>
    </View>
  );
}

function WarningText({ m, card }: { m: TreatmentModel; card: RecommendationCardInput }) {
  const c = useTrioColors();
  const warn = recommendationWarning(card);
  const tone = c.dark ? c.orange : c.accent;
  if (!warn) return null;
  const line = (text: string, color = tone) => (
    <T style_="subheadline" color={color} align="center">
      {text}
    </T>
  );
  switch (warn.kind) {
    case 'stale':
      return line('Last loop was > 15 m ago.');
    case 'veryLow':
      return line('Glucose is very low.', c.red);
    case 'forecastLow':
      return line('Glucose forecast is very low.');
    case 'maxBolus':
      return line(`Max Bolus = ${insulinFormatter(m.maxBolus)} U`);
    case 'iobAboveMax':
      return line(`Current IOB (${insulinFormatter(m.input.iob)} U) > Max IOB (${insulinFormatter(m.maxIOB)} U)`);
    case 'maxIob':
      return (
        <View style={{ alignItems: 'center' }}>
          {line('Limited by Max IOB.')}
          <T style_="footnote" secondary align="center">
            {'Max IOB ('}
            <T style_="footnote">{insulinFormatter(m.maxIOB)}</T>
            {' U) - Current IOB ('}
            <T style_="footnote">{insulinFormatter(m.input.iob)}</T>
            {' U) = '}
            <T style_="footnote" color={c.orange}>
              {insulinFormatter(warn.available)}
            </T>
            {' U'}
          </T>
        </View>
      );
  }
}

function RecommendedBolusCard({ m }: { m: TreatmentModel }) {
  const c = useTrioColors();
  const r = m.result;
  const card: RecommendationCardInput = {
    insulinCalculated: r.insulinCalculated,
    factoredInsulin: r.factoredInsulin,
    iob: m.input.iob,
    maxIOB: m.maxIOB,
    maxBolus: m.maxBolus,
    currentBG: m.input.currentBG,
    minPredBG: m.input.minPredBG,
    lastLoopDate: m.input.lastLoopDate,
    now: m.now,
  };
  const closed = (m.determination?.mode ?? m.loopMode) === 'closed';
  const value = insulinFormatter(r.insulinCalculated, 'down', true);
  return (
    <View style={{ gap: 4 }}>
      <WarningText m={m} card={card} />
      {m.algorithmSuggested > 0 ? (
        <View style={styles.suggested}>
          <View style={{ flex: 1, gap: 2 }}>
            <View style={styles.label}>
              <SymbolView name={closed ? 'circle' : 'circle.dashed'} size={18} tintColor={c.primary} />
              <T style_="subheadline">{closed ? 'Closed Loop' : 'Open Loop'}</T>
            </View>
            <T style_="footnote" secondary>
              Buddy would give
            </T>
          </View>
          <View style={styles.amount}>
            <T style_="headline">{insulinFormatter(m.algorithmSuggested, 'down', true)}</T>
            <T style_="subheadline" secondary>
              U
            </T>
          </View>
        </View>
      ) : null}
      <View style={[styles.card, { backgroundColor: `${c.accent}1A` }]} accessible accessibilityLabel="Recommended Bolus" accessibilityValue={{ text: `${value} units` }}>
        <View style={{ gap: 4 }}>
          <T style_="headline">Recommended Bolus</T>
          {isRoundedForPump(card) ? (
            <T style_="footnote" secondary>
              Rounded for pump
            </T>
          ) : null}
        </View>
        <View style={{ flex: 1 }} />
        <View style={styles.amount}>
          <T style_="title3" weight="700" color={r.insulinCalculated > 0 ? c.accent : c.primary}>
            {value}
          </T>
          <T style_="subheadline" secondary>
            U
          </T>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  title: { marginTop: 28, marginBottom: 12 },
  list: { paddingHorizontal: 16, paddingBottom: 16 },
  footer: { paddingHorizontal: 16, gap: 10 },
  suggested: { flexDirection: 'row', alignItems: 'flex-start', paddingHorizontal: 16, paddingVertical: 8 },
  label: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  amount: { flexDirection: 'row', alignItems: 'baseline', gap: 4 },
  card: { flexDirection: 'row', alignItems: 'center', borderRadius: 12, borderCurve: 'continuous', paddingHorizontal: 16, paddingVertical: 12 },
  gotIt: { height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
});
