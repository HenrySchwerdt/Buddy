import { useMemo } from 'react';
import { useSettings } from '@/runtime/settings-store';
import { TherapyScheduleEditor } from '@/features/settings/components/therapy-editor';
import { fmtGlucoseValue, pickerValues } from '@/features/settings/picker';
import { useTrioColors } from '@/trio';

/** Port of TargetsEditor.RootView: one target per entry (Trio stores low = high). */
export default function GlucoseTargets() {
  const units = useSettings((s) => s.units);
  const c = useTrioColors();
  const options = useMemo(() => pickerValues({ step: 1, min: 72, max: 180, kind: 'glucose' }, units), [units]);
  return (
    <TherapyScheduleEditor
      scheduleKey="target"
      title="Glucose Targets"
      valueOptions={options}
      formatValue={(v) => fmtGlucoseValue(v, units)}
      unit={units}
      chart={{ color: c.green, fillsArea: false, lineWidth: 2.5, yDomain: [72, 180], accessibilityLabel: 'Glucose target profile chart, 24 hours' }}
      read={(v) => v.low}
      write={(v) => ({ low: v, high: v })}
    />
  );
}
