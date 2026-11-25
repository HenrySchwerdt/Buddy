import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { isOverrideActive, isTempTargetActive } from '@buddy/core';
import { adjustmentDefaults, cancelOverride, cancelTempTarget, ensureScheduler } from '@/features/adjustments/actions';
import { actionSheet } from '@/features/adjustments/components/rows';
import { OverridesTab } from '@/features/adjustments/OverridesTab';
import { StickyStopBar, type PresetActivation } from '@/features/adjustments/shared';
import { useAdjustmentsStore } from '@/features/adjustments/store';
import { TempTargetsTab } from '@/features/adjustments/TempTargetsTab';
import { useRuntime } from '@/runtime/runtime';
import { useSettings } from '@/runtime/settings-store';
import { CapsuleButton, Segmented, TrioScreen } from '@/trio';

type Tab = 'overrides' | 'tempTargets';

/** Trio shows the preset's checkmark for 3 s after starting it. */
const CHECKMARK_MS = 3000;
/** Sticky bar height + Trio's 30 pt safe-area spacing, kept free at the end of the list. */
const STICKY_SPACE = 95;
/** Offset of the sticky bar above the floating tab bar. */
const TAB_BAR_TOP = 62;

/** Trio dev's Adjustments tab (AdjustmentsRootView): Overrides and Temp Targets with presets. */
export default function AdjustmentsScreen() {
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<Tab>('overrides');
  const [checked, setChecked] = useState<{ kind: PresetActivation['kind']; id: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const s = useSettings();
  const now = useRuntime((r) => r.now);
  const requireConfirmation = useAdjustmentsStore((a) => a.requireAdjustmentsConfirmation);
  const defaults = useMemo(() => adjustmentDefaults(), [s.algorithmId, s.algorithmSettings]);
  const overrideRunning = isOverrideActive(s.override, now);
  const tempTargetRunning = isTempTargetActive(s.tempTarget, now);

  useEffect(() => {
    ensureScheduler();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const activate = (a: PresetActivation) => {
    const go = () => {
      a.run();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setChecked({ kind: a.kind, id: a.id });
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setChecked(null), CHECKMARK_MS);
    };
    if (!requireConfirmation) return go();
    actionSheet({ title: 'Activate Preset', message: `Start the ${a.kind === 'override' ? 'Override' : 'Temp Target'} "${a.name}"?`, actions: [{ label: 'Activate', onPress: go }] });
  };

  const stopOverride = () =>
    actionSheet({ title: 'Override to Stop', message: `Stop the Override "${s.override?.name ?? ''}"?`, actions: [{ label: 'Stop', destructive: true, onPress: cancelOverride }] });
  const stopTempTarget = () =>
    actionSheet({ title: 'Temp Target to Stop', message: `Stop the Temp Target "${s.tempTarget?.name ?? ''}"?`, actions: [{ label: 'Stop', destructive: true, onPress: cancelTempTarget }] });

  const sticky = tab === 'overrides' ? (overrideRunning ? { label: 'Stop Override', onPress: stopOverride } : null) : tempTargetRunning ? { label: 'Stop Temp Target', onPress: stopTempTarget } : null;

  return (
    <View style={{ flex: 1 }}>
      <TrioScreen
        title="Adjustments"
        trailing={
          tab === 'overrides' ? (
            <CapsuleButton label="Add Override" icon="plus" onPress={() => router.push('/override-editor')} />
          ) : (
            <CapsuleButton label="Add Temp Target" icon="plus" onPress={() => router.push('/temp-target-editor')} />
          )
        }>
        <Segmented
          options={[
            { value: 'overrides', label: 'Overrides' },
            { value: 'tempTargets', label: 'Temp Targets' },
          ]}
          value={tab}
          onChange={setTab}
        />
        <View style={{ gap: 10 }}>
          {tab === 'overrides' ? (
            <OverridesTab running={overrideRunning} checkedId={checked?.kind === 'override' ? checked.id : null} onActivate={activate} defaults={defaults} />
          ) : (
            <TempTargetsTab running={tempTargetRunning} now={now} checkedId={checked?.kind === 'tempTarget' ? checked.id : null} onActivate={activate} behavior={defaults.behavior} />
          )}
        </View>
        {sticky ? <View style={{ height: STICKY_SPACE }} /> : null}
      </TrioScreen>
      {sticky ? <StickyStopBar label={sticky.label} onPress={sticky.onPress} bottom={insets.bottom + TAB_BAR_TOP} /> : null}
    </View>
  );
}
