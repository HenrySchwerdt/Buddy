import { TherapyScheduleEditor } from '@/features/settings/components/therapy-editor';
import { useTrioColors } from '@/trio';

/** Trio: stride(from: 10, to: 501, by: 1) / 10 → 1.0 … 50.0 g/U. */
const OPTIONS = Array.from({ length: 491 }, (_, i) => (i + 10) / 10);

/** Port of CarbRatioEditor.RootView. */
export default function CarbRatios() {
  const c = useTrioColors();
  return (
    <TherapyScheduleEditor
      scheduleKey="carbRatio"
      title="Carb Ratios"
      valueOptions={OPTIONS}
      formatValue={(v) => String(v)}
      unit="g/U"
      chart={{ color: c.orange, accessibilityLabel: 'Carb ratio profile chart, 24 hours' }}
      read={(v) => v}
      write={(v) => v}
    />
  );
}
