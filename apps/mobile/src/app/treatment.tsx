import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { useSnapshot } from '@/runtime/hooks';
import { now } from '@/runtime/runtime';
import { CapsuleButton, CheckboxRow, InputRow, Section, SheetScreen, T, useTrioColors } from '@/trio';
import { useTreatmentDraft } from '@/features/treatment/draft-store';
import { ForecastChart } from '@/features/treatment/forecast-chart';
import { bolusAmountFormatter, bolusWarning, limitExceededLabel, progressText, treatmentButtonLabel } from '@/features/treatment/formatting';
import { BolusOptionsRow, BolusRow, FatProteinRow, RecommendationRow, sanitizeInteger, TimeRow } from '@/features/treatment/rows';
import { simulateDecision } from '@/features/treatment/simulate';
import { invokeTreatments } from '@/features/treatment/submit';
import { BusyOverlay, TreatmentButton } from '@/features/treatment/treatment-button';
import { useTreatmentModel } from '@/features/treatment/use-treatment-model';

/** Trio's debounce for macro input before re-running the forecast. */
const SIMULATION_DEBOUNCE_MS = 350;

/** Port of Trio's Treatments sheet (`Treatments.RootView`). */
export default function TreatmentSheet() {
  const c = useTrioColors();
  const m = useTreatmentModel();
  const snap = useSnapshot();
  const draft = useTreatmentDraft();
  const set = draft.set;
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    useTreatmentDraft.getState().reset(now());
    return () => useTreatmentDraft.getState().reset(now());
  }, []);

  // Re-simulate the forecast with the entered carbs/bolus/time (debounced like Trio).
  const { carbs, amount, backdated } = m;
  useEffect(() => {
    const id = setTimeout(() => {
      const simulated = carbs > 0 || amount > 0 || backdated ? simulateDecision({ carbs, carbsDate: draft.date, bolus: amount }) : null;
      const simulatedForCalc = amount === 0 ? simulated : carbs > 0 || backdated ? simulateDecision({ carbs, carbsDate: draft.date, bolus: 0 }) : null;
      set({ simulated, simulatedForCalc });
    }, SIMULATION_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [carbs, amount, backdated, draft.date, set]);

  const ts = m.settings;
  const buttonState = { amount: m.amount, carbs: m.carbs, fat: m.fat, protein: m.protein, externalInsulin: draft.externalInsulin, maxBolus: m.maxBolus, maxCarbs: ts.maxCarbs, maxFat: ts.maxFat, maxProtein: ts.maxProtein };
  const limitExceeded = limitExceededLabel(buttonState) !== null;
  const warning = bolusWarning({ externalInsulin: draft.externalInsulin, amount: m.amount, currentBG: m.input.currentBG, minPredBG: m.forecastMinPredBG, confirmBolus: ts.confirmBolus });
  const recommendation = m.result.insulinCalculated;

  const run = async () => {
    if (!(m.amount > 0 || m.carbs > 0 || m.fat > 0 || m.protein > 0)) {
      router.back();
      return;
    }
    setBusy(true);
    const outcome = await invokeTreatments({
      carbs: m.carbs,
      fat: m.fat,
      protein: m.protein,
      amount: m.amount,
      note: draft.note,
      externalInsulin: draft.externalInsulin,
      date: draft.date,
      backdated: m.backdated,
      maxBolus: m.maxBolus,
      maxCarbs: ts.maxCarbs,
      maxFat: ts.maxFat,
      maxProtein: ts.maxProtein,
      fpu: ts,
    });
    setBusy(false);
    if (outcome.ok) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.back();
      return;
    }
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    Alert.alert('Error while processing Treatment', outcome.message, [{ text: 'OK', style: 'cancel', onPress: () => router.back() }]);
  };

  const onPress = () => {
    if (!warning.shouldConfirm) return void run();
    Alert.alert(`${warning.message} Bolus ${bolusAmountFormatter(m.amount)} U?`, undefined, [
      { text: 'Cancel', style: 'cancel' },
      { text: warning.message ? 'Ignore Warning and Enact Bolus' : 'Enact Bolus', style: warning.message ? 'destructive' : 'default', onPress: () => void run() },
    ]);
  };

  return (
    <View style={{ flex: 1 }}>
      <SheetScreen
        title="Treatments"
        leading={<CapsuleButton label="Close" color={c.primary} onPress={() => router.back()} />}
        trailing={ts.displayPresets ? <CapsuleButton label="Presets" icon="plus" color={c.primary} onPress={() => router.push('/treatment-presets')} /> : undefined}>
        <View style={[styles.chartCard, { backgroundColor: c.chart }]}>
          <ForecastChart
            c={c}
            now={m.now}
            glucose={snap.glucose}
            predictions={m.forecast}
            units={m.units}
            carbs={m.backdated ? 0 : m.carbs}
            amount={m.amount}
            eventualBG={m.eventualBG}
          />
        </View>

        <Section>
          <InputRow label="Carbs" value={draft.carbs} onChangeText={(t) => set({ carbs: sanitizeInteger(t) })} unit="g" keyboardType="number-pad" maxLength={3} />
          {ts.useFPUconversion ? <FatProteinRow fat={draft.fat} protein={draft.protein} onFat={(t) => set({ fat: t })} onProtein={(t) => set({ protein: t })} /> : null}
          <TimeRow date={draft.date} pushed={draft.timePushed} onPush={() => set({ timePushed: true })} onChange={(d) => set({ date: d })} />
          <InputRow icon="square.and.pencil" value={draft.note} onChangeText={(t) => set({ note: t })} placeholder="Note..." keyboardType="default" maxLength={25} />
        </Section>

        <Section>
          {ts.fattyMeals || ts.sweetMeals ? (
            <BolusOptionsRow
              fattyMeals={ts.fattyMeals}
              sweetMeals={ts.sweetMeals}
              fatty={draft.useFattyMealCorrectionFactor}
              superBolus={draft.useSuperBolus}
              onFatty={(v) => set({ useFattyMealCorrectionFactor: v, ...(v ? { useSuperBolus: false } : {}) })}
              onSuper={(v) => set({ useSuperBolus: v, ...(v ? { useFattyMealCorrectionFactor: false } : {}) })}
            />
          ) : null}
          <RecommendationRow
            value={recommendation}
            disabled={recommendation === 0 || m.amount === recommendation}
            onInfo={() => router.push('/bolus-details')}
            onUse={() => set({ amount: bolusAmountFormatter(recommendation, 'en-US') })}
          />
          <BolusRow value={draft.amount} onChangeText={(t) => set({ amount: t })} />
          <CheckboxRow label="External Insulin" value={draft.externalInsulin} onChange={(v) => set({ externalInsulin: v })} />
        </Section>

        <View style={{ gap: 6 }}>
          {warning.message ? (
            <T style_="subheadline" color={warning.tone === 'red' ? c.red : c.dark ? c.orange : c.accent} align="center">
              {warning.message}
            </T>
          ) : null}
          <TreatmentButton label={treatmentButtonLabel(buttonState)} onPress={onPress} disabled={busy || limitExceeded} limitExceeded={limitExceeded} />
        </View>
      </SheetScreen>
      {busy ? <BusyOverlay text={progressText(m.amount, m.carbs)} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  chartCard: { borderRadius: 26, borderCurve: 'continuous', paddingHorizontal: 16, paddingTop: 22, paddingBottom: 30 },
});
