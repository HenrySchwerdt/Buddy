import { StyleSheet, View } from 'react-native';
import { T, useTrioColors } from '@/trio';
import { TherapyScheduleEditor } from '@/features/settings/components/therapy-editor';
import type { EditorItem } from '@/features/settings/components/schedule-editor';
import { basalTotal, fmtBasal } from '@/features/settings/basal';

/** Trio's fallback when the pump reports no supported rates: 0.05 … 10 U/hr in 0.05 steps. */
const OPTIONS = Array.from({ length: 200 }, (_, i) => Math.round((i + 1) * 5) / 100);

/** Port of BasalProfileEditor.RootView. */
export default function BasalRates() {
  const c = useTrioColors();
  return (
    <TherapyScheduleEditor
      scheduleKey="basal"
      title="Basal Rates"
      valueOptions={OPTIONS}
      formatValue={fmtBasal}
      unit="U/hr"
      chart={{ color: c.purple, accessibilityLabel: 'Basal rate profile chart, 24 hours' }}
      read={(v) => v}
      write={(v) => v}
      footer={(items) => <TotalRow items={items} />}
    />
  );
}

function TotalRow({ items }: { items: readonly EditorItem[] }) {
  const c = useTrioColors();
  if (items.length === 0) return null;
  return (
    <View style={[styles.total, { backgroundColor: `${c.chart}A6` }]}>
      <T weight="700" style={{ flex: 1 }}>
        Total
      </T>
      <T>{String(Math.round(basalTotal(items) * 1000) / 1000)}</T>
      <T secondary>U/day</T>
    </View>
  );
}

const styles = StyleSheet.create({
  total: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 16, borderRadius: 10 },
});
