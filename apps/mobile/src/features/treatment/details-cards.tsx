import { View } from 'react-native';
import { T, useTrioColors } from '@/trio';
import { Cell, FormulaRow, FormulaSection, Op, Solution } from './formula';
import { formatGlucoseDelta, formatGlucoseValue, formatIsf, formatWholePercent, insulinFormatter, wrapNegative } from './formatting';
import type { TreatmentModel } from './use-treatment-model';

const cr = (v: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(v);

/** All calculation cards of Trio's PopupView, in order. */
export function CalculationCards({ m }: { m: TreatmentModel }) {
  const { input: i, result: r, units } = m;
  const u = units;
  return (
    <View>
      <FormulaSection title="Glucose Calculation">
        <FormulaRow>
          <Op>(</Op>
          <Cell header="Current" value={formatGlucoseValue(i.currentBG, u)} unit={u} />
          <Op>−</Op>
          <Cell header="Target" value={formatGlucoseValue(i.target, u)} unit={u} />
          <Op>) /</Op>
          <Cell header="ISF" value={formatIsf(i.isf, u)} unit={`${u}/U`} />
          <Op grow>=</Op>
          <Solution value={r.targetDifferenceInsulin} display={insulinFormatter(r.targetDifferenceInsulin)} />
        </FormulaRow>
      </FormulaSection>

      <FormulaSection title="Insulin On Board (IOB)">
        <FormulaRow>
          <Cell value="-1" />
          <Op>×</Op>
          <Cell header="IOB" value={insulinFormatter(i.iob, 'plain')} unit="U" />
          <Op grow>=</Op>
          <Solution value={-i.iob} display={insulinFormatter(-i.iob, 'plain')} />
        </FormulaRow>
      </FormulaSection>

      <CobCard m={m} />

      <FormulaSection title="Glucose Trend (15 min)">
        <FormulaRow>
          <Cell header="Delta" value={formatGlucoseDelta(i.deltaBG, u)} unit={u} />
          <Op>/</Op>
          <Cell header="ISF" value={formatIsf(i.isf, u)} unit={`${u}/U`} />
          <Op grow>=</Op>
          <Solution value={r.fifteenMinutesInsulin} display={insulinFormatter(r.fifteenMinutesInsulin)} />
        </FormulaRow>
      </FormulaSection>

      <FormulaSection title="Full Bolus">
        <FormulaRow>
          <Cell header="Glucose" value={wrapNegative(r.targetDifferenceInsulin)} unit="U" />
          <Op grow>+</Op>
          <Cell header="IOB" value={wrapNegative(-i.iob, 'plain')} unit="U" />
          <Op grow>+</Op>
          <Cell header="COB" value={wrapNegative(r.wholeCobInsulin)} unit="U" />
          <Op grow>+</Op>
          <Cell header="Delta" value={wrapNegative(r.fifteenMinutesInsulin)} unit="U" />
        </FormulaRow>
        <SumRow value={r.wholeCalc} />
      </FormulaSection>

      {m.draft.useSuperBolus ? (
        <FormulaSection title="Super Bolus">
          <FormulaRow>
            <Cell header="Basal Rate" value={new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(i.basal)} unit="U/hr" />
            <Op>×</Op>
            <Cell header="Super Bolus %" value={formatWholePercent(i.sweetMealFactor)} minWidth={90} />
            <Op grow>=</Op>
            <Solution value={r.superBolusInsulin} display={insulinFormatter(r.superBolusInsulin)} />
          </FormulaRow>
        </FormulaSection>
      ) : null}

      {r.factoredInsulin > 0 ? <FactorsCard m={m} /> : null}
    </View>
  );
}

function SumRow({ value }: { value: number }) {
  const c = useTrioColors();
  const color = value < 0 ? c.red : value === 0 ? c.primary : c.green;
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'baseline', gap: 4, paddingHorizontal: 6 }}>
      <T secondary>=</T>
      <T style_="headline" weight="700" color={color}>
        {insulinFormatter(value)}
      </T>
      <T style_="footnote" secondary>
        U
      </T>
    </View>
  );
}

function CobCard({ m }: { m: TreatmentModel }) {
  const c = useTrioColors();
  const { result: r } = m;
  const carbs = m.backdated ? 0 : m.carbs;
  const exceeded = m.displayedCob + carbs > m.input.maxCOB;
  return (
    <FormulaSection title="Carbs On Board (COB)">
      <FormulaRow>
        <Op>(</Op>
        <Cell header="COB" value={String(Math.trunc(m.displayedCob))} unit="g" />
        <Op>+</Op>
        <Cell header="Carbs" value={String(Math.trunc(carbs))} unit="g" />
        <Op>) /</Op>
        <Cell header="CR" value={cr(m.input.carbRatio)} unit="g/U" />
        <Op grow>=</Op>
        {!exceeded ? <Solution value={r.wholeCobInsulin} display={insulinFormatter(r.wholeCobInsulin)} /> : null}
      </FormulaRow>
      {m.backdated ? (
        <T style_="caption" color={c.orange} style={{ paddingHorizontal: 6, paddingTop: 4 }}>
          {`Backdated carbs (${m.carbs} g) included in COB calculation`}
        </T>
      ) : null}
      {exceeded ? (
        <FormulaRow>
          <Cell header="Max COB" value={String(Math.trunc(r.wholeCob))} unit="g" color={c.orange} />
          <Op>/</Op>
          <Cell header="CR" value={cr(m.input.carbRatio)} unit="g/U" />
          <Op grow>=</Op>
          <Solution value={r.wholeCobInsulin} display={insulinFormatter(r.wholeCobInsulin)} />
        </FormulaRow>
      ) : null}
    </FormulaSection>
  );
}

function FactorsCard({ m }: { m: TreatmentModel }) {
  const { result: r, input: i, draft } = m;
  const solution = <Solution value={r.factoredInsulin} display={insulinFormatter(r.factoredInsulin)} />;
  if (draft.useSuperBolus) {
    return (
      <FormulaSection title="Applied Factors">
        {r.wholeCalc > 0 ? (
          <FormulaRow>
            <Op>(</Op>
            <Cell header="Full Bolus" value={insulinFormatter(r.wholeCalc)} unit="U" />
            <Op>×</Op>
            <Cell header="Rec. %" value={formatWholePercent(i.fraction)} />
            <Op>) +</Op>
            <Cell header="Super Bolus" value={insulinFormatter(r.superBolusInsulin)} unit="U" />
            <Op grow>=</Op>
            {solution}
          </FormulaRow>
        ) : (
          <FormulaRow>
            <Cell header="Full Bolus" value={insulinFormatter(r.wholeCalc)} unit="U" />
            <Op>+</Op>
            <Cell header="Super Bolus" value={insulinFormatter(r.superBolusInsulin)} unit="U" />
            <Op grow>=</Op>
            {solution}
          </FormulaRow>
        )}
      </FormulaSection>
    );
  }
  return (
    <FormulaSection title="Applied Factors">
      <FormulaRow>
        <Cell header="Full Bolus" value={insulinFormatter(r.wholeCalc)} unit="U" />
        <Op>×</Op>
        <Cell header="Rec. Bolus %" value={formatWholePercent(i.fraction)} />
        {draft.useFattyMealCorrectionFactor ? (
          <>
            <Op>×</Op>
            <Cell header="Red. Bolus %" value={formatWholePercent(i.fattyMealFactor)} />
          </>
        ) : null}
        <Op grow>=</Op>
        {solution}
      </FormulaRow>
    </FormulaSection>
  );
}
