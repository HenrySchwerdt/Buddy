import { router } from 'expo-router';
import { SymbolView } from '@/trio/symbol';
import type { ActiveTempTarget, TargetBehavior, TempTargetPreset } from '@buddy/core';
import { useSettings } from '@/runtime/settings-store';
import { Section, T, useTrioColors } from '@/trio';
import { deleteScheduledTempTarget, deleteTempTargetPreset, moveTempTargetPreset, startTempTargetPreset } from './actions';
import { TintedRow } from './components/form-bits';
import { actionSheet, PresetRow, SwipeHintFooter, SwipeRow } from './components/rows';
import { formatCountdown, tempTargetCaption } from './format';
import { EmptyHint, type PresetActivation } from './shared';
import { useAdjustmentsStore } from './store';

/** Color.loopGreen.opacity(0.8) */
const LOOP_GREEN_80 = 'rgba(111,207,151,0.8)';

/** Trio `AdjustmentsRootView.tempTargets()`. */
export function TempTargetsTab({ running, now, checkedId, onActivate, behavior }: { running: boolean; now: number; checkedId: string | null; onActivate: (a: PresetActivation) => void; behavior: TargetBehavior }) {
  const c = useTrioColors();
  const s = useSettings();
  const scheduled = useAdjustmentsStore((a) => a.scheduledTempTargets);
  const active = running ? s.tempTarget : null;

  const editPreset = (p: TempTargetPreset) => router.push({ pathname: '/temp-target-editor', params: { preset: p.id } });
  const editActive = (t: ActiveTempTarget) => router.push({ pathname: '/temp-target-editor', params: { active: t.id } });
  const confirmDelete = (p: TempTargetPreset) => {
    const isRunning = active?.presetId === p.id;
    actionSheet({
      title: `Delete the Temp Target Preset "${p.name}"?`,
      message: isRunning ? 'This Temp Target preset is currently running. Deleting will stop it.' : undefined,
      actions: [{ label: isRunning ? 'Stop and Delete' : 'Delete', destructive: true, onPress: () => deleteTempTargetPreset(p.id) }],
    });
  };
  const confirmDeleteScheduled = (t: ActiveTempTarget) =>
    actionSheet({ title: `Delete the Temp Target Preset "${t.name}"?`, actions: [{ label: 'Delete', destructive: true, onPress: () => deleteScheduledTempTarget(t.id) }] });
  const contextMenu = (p: TempTargetPreset, index: number) =>
    actionSheet({
      title: p.name,
      actions: [
        { label: 'Delete', destructive: true, onPress: () => confirmDelete(p) },
        { label: 'Edit', onPress: () => editPreset(p) },
        ...(index > 0 ? [{ label: 'Move Up', onPress: () => moveTempTargetPreset(p.id, -1) }] : []),
        ...(index < s.tempTargetPresets.length - 1 ? [{ label: 'Move Down', onPress: () => moveTempTargetPreset(p.id, 1) }] : []),
      ],
    });

  return (
    <>
      {active ? (
        <TintedRow color={LOOP_GREEN_80} onPress={() => editActive(active)} hint="Double tap to edit">
          <T style={{ flex: 1 }}>{`${active.name} is running`}</T>
          <SymbolView name="square.and.pencil" size={18} tintColor={c.primary} />
        </TintedRow>
      ) : null}
      {scheduled.length > 0 ? (
        <Section header="Scheduled Temp Targets">
          {scheduled.map((t) => (
            <SwipeRow key={t.id} onDelete={() => confirmDeleteScheduled(t)} onEdit={() => editActive(t)}>
              <PresetRow
                name={t.name}
                labels={[tempTargetCaption(t, s.units, behavior)]}
                trailingNote={t.startedAt > now ? `Starts in ${formatCountdown(t.startedAt - now)}` : undefined}
                checked={false}
                showHandle={false}
              />
            </SwipeRow>
          ))}
        </Section>
      ) : null}
      {s.tempTargetPresets.length > 0 ? (
        <Section header="Temporary Target Presets" footer={<SwipeHintFooter text="Swipe left to edit or delete a temporary target preset. Hold, drag and drop to reorder a preset." />}>
          {s.tempTargetPresets.map((p, i) => (
            <SwipeRow key={p.id} onDelete={() => confirmDelete(p)} onEdit={() => editPreset(p)}>
              <PresetRow
                name={p.name}
                labels={[tempTargetCaption(p, s.units, behavior)]}
                checked={checkedId === p.id}
                onPress={() => onActivate({ kind: 'tempTarget', id: p.id, name: p.name, run: () => startTempTargetPreset(p) })}
                onLongPress={() => contextMenu(p, i)}
                accessibilityHint="Enables this temp target"
              />
            </SwipeRow>
          ))}
        </Section>
      ) : (
        <EmptyHint text="Add Preset or Temp Target by tapping 'Add Temp Target +' in the top right-hand corner of the screen." />
      )}
    </>
  );
}
