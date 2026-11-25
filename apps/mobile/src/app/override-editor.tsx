import { useLocalSearchParams } from 'expo-router';
import { OverrideForm, type OverrideFormMode } from '@/features/adjustments/OverrideForm';
import { useSettings } from '@/runtime/settings-store';

/** Add Override / Edit Override sheet. `?preset=<id>` edits a preset, `?running=1` the running override. */
export default function OverrideEditor() {
  const { preset, running } = useLocalSearchParams<{ preset?: string; running?: string }>();
  const s = useSettings();
  const toEdit = preset ? s.overridePresets.find((p) => p.id === preset) : undefined;
  const mode: OverrideFormMode = toEdit ? { kind: 'editPreset', preset: toEdit } : running && s.override ? { kind: 'editRunning', override: s.override } : { kind: 'add' };
  return <OverrideForm mode={mode} />;
}
