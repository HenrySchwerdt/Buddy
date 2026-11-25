import { toMmol, type GlucoseUnit } from '@buddy/core';
import { useEffect, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { TherapyChart } from '../chart';
import { TherapySettingEditor } from '../editor';
import { PUMP_MODELS, fmtBasal, fmtNumber, glucoseValue, totalDailyBasal, type TherapyItem } from '../logic';
import { scheduleOptions, useOnboardingDraft, type ScheduleKey } from '../store';
import { ACCENT, OB, OT } from '../theme';
import { Card, Footnote, Headline, MenuPickerCard, Stack } from '../ui';

export function UnitSelectionStep() {
  const units = useOnboardingDraft((s) => s.units);
  const pumpModelId = useOnboardingDraft((s) => s.pumpModelId);
  const setUnits = useOnboardingDraft((s) => s.setUnits);
  const setPumpModel = useOnboardingDraft((s) => s.setPumpModel);
  return (
    <Stack>
      <Headline>Please choose from the options below.</Headline>
      <MenuPickerCard<GlucoseUnit> label="Glucose Units" value={units} options={[{ value: 'mg/dL', label: 'mg/dL' }, { value: 'mmol/L', label: 'mmol/L' }]} onChange={setUnits} />
      <MenuPickerCard<string> label="Pump Model" value={pumpModelId} options={PUMP_MODELS.map((p) => ({ value: p.id, label: p.name }))} onChange={setPumpModel} />
      <Footnote>Note: Choosing your pump model determines which increments for setting up your basal rates are available. You will pair your actual pump after finishing the onboarding process.</Footnote>
    </Stack>
  );
}

/** Seeds the schedule on first appearance and returns it with its value grid and a setter. */
function useSchedule(key: ScheduleKey) {
  const items = useOnboardingDraft((s) => s[key]);
  const units = useOnboardingDraft((s) => s.units);
  const pumpModelId = useOnboardingDraft((s) => s.pumpModelId);
  const seed = useOnboardingDraft((s) => s.seedSchedule);
  const setSchedule = useOnboardingDraft((s) => s.setSchedule);
  useEffect(() => seed(key), [key, seed]);
  return { items, units, options: scheduleOptions(key, { units, pumpModelId }), onChange: (next: TherapyItem[]) => setSchedule(key, next) };
}

const asDisplay = (units: GlucoseUnit) => (v: number) => (units === 'mg/dL' ? v : Math.round(toMmol(v) * 10) / 10);

/** Chart card (top-rounded) followed by the entries editor. */
function ScheduleCard({ chart, editor, show }: { chart: ReactNode; editor: ReactNode; show: boolean }) {
  return (
    <View>
      {show ? <View style={styles.chartCard}>{chart}</View> : null}
      {editor}
    </View>
  );
}

function ExampleCalculation({ title, formula, color }: { title: string; formula: string; color: string }) {
  return (
    <View style={{ gap: 8, marginTop: 20 }}>
      <OT style_="headline" style={styles.inset}>
        Example Calculation
      </OT>
      <OT style_="subheadline" style={styles.inset}>
        {title}
      </OT>
      <Card style={{ alignItems: 'center' }}>
        <OT color={color} style={{ fontFamily: 'Menlo' }}>
          {formula}
        </OT>
      </Card>
    </View>
  );
}

function WhatThisMeans({ lines }: { lines: readonly string[] }) {
  return (
    <View style={{ gap: 8, marginTop: 20 }}>
      <OT style_="headline" style={styles.inset}>
        What This Means
      </OT>
      <View style={[styles.inset, { gap: 4 }]}>
        {lines.map((l) => (
          <OT key={l} style_="caption" secondary>{`• ${l}`}</OT>
        ))}
      </View>
    </View>
  );
}

export function GlucoseTargetStep() {
  const { items, units, options, onChange } = useSchedule('targets');
  const fmt = (v: number) => glucoseValue(v, units);
  const toDisplay = asDisplay(units);
  return (
    <ScheduleCard
      show={items.length > 0}
      chart={<TherapyChart items={items} color={ACCENT.green} display={toDisplay} fill={false} lineWidth={2.5} yDomain={[toDisplay(72), toDisplay(180)]} label="Glucose target schedule chart" />}
      editor={<TherapySettingEditor items={items} onChange={onChange} options={options} format={fmt} unit={units} />}
    />
  );
}

export function BasalProfileStep() {
  const { items, options, onChange } = useSchedule('basal');
  return (
    <View>
      <ScheduleCard
        show={items.length > 0}
        chart={<TherapyChart items={items} color={ACCENT.purple} label="Basal rate schedule chart" />}
        editor={<TherapySettingEditor items={items} onChange={onChange} options={options} format={fmtBasal} unit="U/hr" />}
      />
      {items.length > 0 ? (
        <Card style={[styles.total, { marginTop: 20 }]}>
          <OT weight="700" style={{ flex: 1 }}>
            Total
          </OT>
          <OT>{fmtNumber(totalDailyBasal(items))}</OT>
          <OT secondary>U/day</OT>
        </Card>
      ) : null}
    </View>
  );
}

export function CarbRatioStep() {
  const { items, options, onChange } = useSchedule('carbRatios');
  const first = items[0]?.value;
  return (
    <View>
      <ScheduleCard
        show={items.length > 0}
        chart={<TherapyChart items={items} color={ACCENT.orange} label="Carb ratio schedule chart" />}
        editor={<TherapySettingEditor items={items} onChange={onChange} options={options} format={fmtNumber} unit="g/U" />}
      />
      {first !== undefined ? (
        <>
          <ExampleCalculation title="For 45 g of carbs, you would need:" formula={`45 g / ${fmtNumber(Math.round(first * 10) / 10)} g/U = ${(45 / first).toFixed(1)} U`} color={ACCENT.orange} />
          <WhatThisMeans
            lines={[
              'A ratio of 10 g/U means 1 unit of insulin covers 10 g of carbs',
              'A lower number means you need more insulin for the same amount of carbs',
              'A higher number means you need less insulin for the same amount of carbs',
              'Different times of day may require different ratios',
            ]}
          />
        </>
      ) : null}
    </View>
  );
}

export function InsulinSensitivityStep() {
  const { items, units, options, onChange } = useSchedule('isf');
  const first = items[0]?.value;
  const fmt = (v: number) => glucoseValue(v, units);
  const toDisplay = asDisplay(units);
  return (
    <View>
      <ScheduleCard
        show={items.length > 0}
        chart={<TherapyChart items={items} color={ACCENT.cyan} display={toDisplay} label="Insulin sensitivity schedule chart" />}
        editor={<TherapySettingEditor items={items} onChange={onChange} options={options} format={fmt} unit={`${units}/U`} />}
      />
      {first !== undefined ? (
        <>
          <ExampleCalculation
            title={`If you are ${fmt(40)} ${units} above target:`}
            formula={`${fmt(40)} ${units} / ${fmt(first)} ${units}/U = ${(toDisplay(40) / toDisplay(first)).toFixed(1)} U`}
            color={ACCENT.cyan}
          />
          <WhatThisMeans
            lines={[
              `An ISF of ${fmt(50)} ${units}/U means 1 U lowers your glucose by ${fmt(50)} ${units}`,
              "A lower number means you're less sensitive (more resistant) to insulin",
              "A higher number means you're more sensitive (less resistant) to insulin",
            ]}
          />
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  inset: { paddingHorizontal: 16 },
  chartCard: { backgroundColor: OB.card, paddingVertical: 16, paddingHorizontal: 16, borderTopLeftRadius: 10, borderTopRightRadius: 10 },
  total: { flexDirection: 'row', alignItems: 'center', gap: 8 },
});
