import { View } from 'react-native';
import { toMmol, type GlucoseReading, type GlucoseUnit } from '@buddy/core';
import { useTrioPrefs } from '@/features/settings/store';
import { glucoseMetrics } from './calc';
import { fixed, pctOne } from './format';
import { Row, StatView } from './ui';

/** GlucoseMetricsView: eA1c, GMI, SD, CV, Days. eA1c and GMI follow the eA1c Display Unit (% or mmol/mol). */
export function GlucoseMetrics({ readings, units }: { readings: readonly GlucoseReading[]; units: GlucoseUnit }) {
  const m = glucoseMetrics(readings);
  const mmolMol = useTrioPrefs((p) => p.eA1cDisplayUnit) === 'mmolMol';
  const ifcc = (v: number) => fixed(v, 1);
  const sd = units === 'mg/dL' ? fixed(m.sd, 0) : fixed(toMmol(m.sd), 1);
  const items = [
    ['eA1c', mmolMol ? ifcc(m.ifcc) : pctOne(m.ngsp / 100)],
    ['GMI', mmolMol ? ifcc(m.gmiMmolMol) : pctOne(m.gmi / 100)],
    ['SD', sd],
    ['CV', pctOne(m.cv / 100)],
    ['Days', fixed(m.days, 1)],
  ] as const;
  return (
    <Row style={{ justifyContent: 'space-between' }}>
      {items.map(([title, value]) => (
        <View key={title}>
          <StatView title={title} value={value} />
        </View>
      ))}
    </Row>
  );
}
