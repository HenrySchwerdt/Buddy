import { router } from 'expo-router';
import { SymbolView } from '@/trio/symbol';
import type { OverridePreset } from '@buddy/core';
import { useSettings } from '@/runtime/settings-store';
import { Section, T, useTrioColors } from '@/trio';
import { deleteOverridePreset, moveOverridePreset, startOverridePreset } from './actions';
import { TintedRow } from './components/form-bits';
import { actionSheet, PresetRow, SwipeHintFooter, SwipeRow } from './components/rows';
import { overrideLabels } from './format';
import { EmptyHint, type PresetActivation } from './shared';

const PURPLE_80 = 'rgba(191,90,242,0.8)';

/** Trio `AdjustmentsRootView.overrides()`. */
export function OverridesTab({ running, checkedId, onActivate, defaults }: { running: boolean; checkedId: string | null; onActivate: (a: PresetActivation) => void; defaults: { smbMinutes: number; uamMinutes: number } }) {
  const c = useTrioColors();
  const s = useSettings();
  const active = running ? s.override : null;

  const edit = (p: OverridePreset) => router.push({ pathname: '/override-editor', params: { preset: p.id } });
  const confirmDelete = (p: OverridePreset) => {
    const isRunning = active?.presetId === p.id;
    actionSheet({
      title: `Delete the Override Preset "${p.name}"?`,
      message: isRunning ? 'This override preset is currently running. Deleting will stop it.' : undefined,
      actions: [{ label: isRunning ? 'Stop and Delete' : 'Delete', destructive: true, onPress: () => deleteOverridePreset(p.id) }],
    });
  };
  const contextMenu = (p: OverridePreset, index: number) =>
    actionSheet({
      title: p.name,
      actions: [
        { label: 'Delete', destructive: true, onPress: () => confirmDelete(p) },
        { label: 'Edit', onPress: () => edit(p) },
        ...(index > 0 ? [{ label: 'Move Up', onPress: () => moveOverridePreset(p.id, -1) }] : []),
        ...(index < s.overridePresets.length - 1 ? [{ label: 'Move Down', onPress: () => moveOverridePreset(p.id, 1) }] : []),
      ],
    });

  return (
    <>
      {active ? (
        <TintedRow color={PURPLE_80} onPress={() => router.push({ pathname: '/override-editor', params: { running: '1' } })} hint="Double tap to edit">
          <T style={{ flex: 1 }}>{`${active.name} is running`}</T>
          <SymbolView name="square.and.pencil" size={18} tintColor={c.primary} />
        </TintedRow>
      ) : null}
      {s.overridePresets.length > 0 ? (
        <Section header="Override Presets" footer={<SwipeHintFooter text="Swipe left to edit or delete an override preset. Hold, drag and drop to reorder a preset." />}>
          {s.overridePresets.map((p, i) => (
            <SwipeRow key={p.id} onDelete={() => confirmDelete(p)} onEdit={() => edit(p)}>
              <PresetRow
                name={p.name}
                labels={overrideLabels(p, s.units, defaults)}
                checked={checkedId === p.id}
                onPress={() => onActivate({ kind: 'override', id: p.id, name: p.name, run: () => startOverridePreset(p) })}
                onLongPress={() => contextMenu(p, i)}
                accessibilityHint="Double tap to enable this override"
              />
            </SwipeRow>
          ))}
        </Section>
      ) : (
        <EmptyHint text="Add Preset or Override by tapping 'Add Override +' in the top right-hand corner of the screen." />
      )}
    </>
  );
}
