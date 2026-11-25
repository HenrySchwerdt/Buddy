import { useLocalSearchParams } from 'expo-router';
import { useAdjustmentsStore } from '@/features/adjustments/store';
import { TempTargetForm, type TempTargetFormMode } from '@/features/adjustments/TempTargetForm';
import { useSettings } from '@/runtime/settings-store';

/** Add / Edit Temp Target sheet. `?preset=<id>` edits a preset, `?active=<id>` the running or a scheduled temp target. */
export default function TempTargetEditor() {
  const { preset, active } = useLocalSearchParams<{ preset?: string; active?: string }>();
  const s = useSettings();
  const scheduled = useAdjustmentsStore((a) => a.scheduledTempTargets);
  const toEdit = preset ? s.tempTargetPresets.find((p) => p.id === preset) : undefined;
  const activeTarget = active ? (s.tempTarget?.id === active ? s.tempTarget : scheduled.find((t) => t.id === active)) : undefined;
  const mode: TempTargetFormMode = toEdit ? { kind: 'editPreset', preset: toEdit } : activeTarget ? { kind: 'editActive', tempTarget: activeTarget } : { kind: 'add' };
  return <TempTargetForm mode={mode} />;
}
