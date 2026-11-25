import { useMemo } from 'react';
import { useSettings } from '@/runtime/settings-store';
import { TherapyScheduleEditor } from '@/features/settings/components/therapy-editor';
import { fmtGlucoseValue, pickerValues } from '@/features/settings/picker';

/** SwiftUI `.cyan` (dark). */
const CYAN = '#64D2FF';

/** Port of ISFEditor.RootView. Values are stored in mg/dL per U. */
export default function InsulinSensitivities() {
  const units = useSettings((s) => s.units);
  const options = useMemo(() => pickerValues({ step: 1, min: 9, max: 540, kind: 'glucose' }, units), [units]);
  return (
    <TherapyScheduleEditor
      scheduleKey="isf"
      title="Insulin Sensitivities"
      valueOptions={options}
      formatValue={(v) => fmtGlucoseValue(v, units)}
      unit={`${units}/U`}
      chart={{ color: CYAN, accessibilityLabel: 'Insulin sensitivity profile chart, 24 hours' }}
      read={(v) => v}
      write={(v) => v}
    />
  );
}
