import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Linking, RefreshControl, ScrollView, StyleSheet, View, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SymbolView } from '@/trio/symbol';
import { isOverrideActive, isTempTargetActive, MINUTE, scheduleValueAt } from '@buddy/core';
import { adjustmentDefaults } from '@/features/adjustments/actions';
import { fmtDelta, fmtG } from '@/features/format';
import { upTo3 } from '@/features/history/rows';
import { AdjustmentPanel } from '@/features/home/adjustment-panel';
import { BolusPanel } from '@/features/home/bolus-panel';
import { useBolusProgress } from '@/features/home/bolus-progress';
import { bobbleGlucoseColor } from '@/features/home/glucose-color';
import { GlucoseBobble, LoopView, PumpView } from '@/features/home/header';
import { BOTTOM_ZONE_H, CHART_MIN_H, HEADER_H, MEAL_H, ZONE_PAD } from '@/features/home/layout';
import { MainChart } from '@/features/home/main-chart';
import { MealSlot } from '@/features/home/meal-slot';
import { PanelBanner } from '@/features/home/multi-use-panel-view';
import { resolveMultiUsePanel } from '@/features/home/multi-use-panel';
import { useNotificationsEnabled } from '@/features/settings-b/use-notification-permission';
import { useHomePrefs } from '@/features/home/prefs';
import { useSensorLifecycle } from '@/features/home/sensor-lifecycle-hook';
import { StatsBanner } from '@/features/home/stats-banner';
import { statsPanelStats } from '@/features/home/stats-panel';
import { useLiveState, useSnapshot } from '@/runtime/hooks';
import { runLoop, useRuntime } from '@/runtime/runtime';
import { useSettings } from '@/runtime/settings-store';
import { dosingModeMiniHint } from '@/features/settings/dosing-mode';
import { GlassChip, T, TAB_BAR_SPACE, TrioBackground, useTrioColors } from '@/trio';

/** Home dashboard: 1:1 layout of Trio dev's HomeRootView. Pull down to force a loop. */
/** Pump clock offset that counts as a time change (Trio flags the pump status badge). */
const PUMP_CLOCK_MISMATCH_MS = 60_000;

export default function HomeScreen() {
  const c = useTrioColors();
  const insets = useSafeAreaInsets();
  const [h, setH] = useState(0);
  const [scrub, setScrub] = useState<number | null>(null);
  const snap = useSnapshot();
  const live = useLiveState();
  const rt = useRuntime();
  const s = useSettings();
  const prefs = useHomePrefs();
  const bolus = useBolusProgress();
  const notificationsDisabled = useNotificationsEnabled() === false;
  const lifecycle = useSensorLifecycle();

  const lastRun = snap.loopRuns.at(-1) ?? null;
  const lastOk = [...snap.loopRuns].reverse().find((r) => !r.error) ?? null;
  const loopAgo = lastOk ? Math.round((live.now - lastOk.date) / MINUTE) : null;
  const closed = s.loopMode === 'closed' && !rt.closedLoopBlocked;
  const bg = live.last?.value ?? null;
  const stale = live.minutesAgo === null || live.minutesAgo > 15;
  const temp = rt.pump?.tempBasal && rt.pump.tempBasal.startedAt + rt.pump.tempBasal.durationMin * MINUTE > live.now ? rt.pump.tempBasal : null;
  const rate = rt.pump?.suspended ? null : temp ? temp.rate : scheduleValueAt(s.profile.basal, live.now, s.profile.utcOffsetMinutes);
  const override = isOverrideActive(s.override, live.now) ? s.override : null;
  const tempTarget = isTempTargetActive(s.tempTarget, live.now) ? s.tempTarget : null;
  const target = scheduleValueAt(s.profile.target, live.now, s.profile.utcOffsetMinutes);
  const colorOpts = { scheme: prefs.scheme, low: prefs.low, high: prefs.high, target: (target.low + target.high) / 2 };
  const stats = useMemo(() => statsPanelStats(snap.glucose, prefs.statsRange, live.now, prefs.tirType), [snap.glucose, prefs.statsRange, prefs.tirType, live.now]);
  const adjust = useMemo(() => adjustmentDefaults(), [s.algorithmId, s.algorithmSettings]);
  const chartH = Math.max(CHART_MIN_H, h - HEADER_H - MEAL_H - BOTTOM_ZONE_H - TAB_BAR_SPACE + 6);
  const basalBand = chartH * 0.1;
  const panel = resolveMultiUsePanel({
    notificationsDisabled,
    pumpTimeMismatch: Math.abs(rt.pump?.clockOffsetMs ?? 0) > PUMP_CLOCK_MISMATCH_MS,
    lastGlucoseDate: live.last?.date ?? null,
    maxIOB: s.limits.maxIOB,
    dosingModeLimited: !!rt.closedLoopBlocked && s.loopMode === 'closed',
    now: live.now,
  });

  const multiUse = () => {
    switch (panel) {
      case 'notificationsDisabled':
        return <PanelBanner icon="bell.slash.fill" title="Notifications Disabled" subtitle="Alarms cannot alert you. Tap to fix." tint={c.red} critical onPress={() => void Linking.openSettings()} />;
      case 'pumpTimeMismatch':
        return <PanelBanner icon="clock.badge.exclamationmark.fill" title="Time Change Detected" subtitle="Pump clock differs from phone. Tap to review." tint={c.orange} onPress={() => router.push('/pump-settings')} />;
      case 'cgmStale':
        return <PanelBanner icon="drop.fill" title="No Recent Glucose" subtitle="Tap to add a fingerstick reading." tint={c.orange} onPress={() => router.push('/add-glucose')} />;
      case 'maxIOBZero':
        return <PanelBanner icon="exclamationmark.triangle.fill" title="Max IOB is 0 U" subtitle="Automated dosing is limited. Tap to review." tint={c.orange} onPress={() => router.push('/settings/units-limits')} />;
      case 'dosingModeLimited':
        return <PanelBanner icon="circle.dashed" title="Open Loop" subtitle={dosingModeMiniHint('open', rt.closedLoopBlocked)} tint={c.orange} onPress={() => router.push('/settings')} />;
      case 'stats':
        return <StatsBanner face={prefs.statsFace} range={prefs.statsRange} stats={stats} units={s.units} a1cUnit={prefs.a1cUnit} onPress={() => router.push('/statistics')} />;
    }
  };

  return (
    <View style={{ flex: 1 }}>
      <TrioBackground />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingTop: insets.top }}
        onLayout={(e) => setH(e.nativeEvent.layout.height - insets.top)}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={rt.looping} onRefresh={() => void runLoop()} tintColor={c.secondary} />}>
        {/* Header: pump | glucose bobble | loop */}
        <View style={[styles.header, { height: HEADER_H }]}>
          <View style={{ flex: 1, alignItems: 'flex-start' }}>
            <PumpView hasPump={!!rt.pump} reservoir={rt.pump?.reservoirUnits ?? null} battery={rt.pump?.batteryPercent ?? null} onPress={() => router.push(rt.pump ? '/pump-settings' : '/add-pump')} />
          </View>
          <GlucoseBobble
            empty={!s.cgmId}
            value={bg === null ? '--' : fmtG(bg, s.units)}
            color={bg === null ? c.primary : bobbleGlucoseColor(bg, colorOpts, c.primary)}
            trend={live.last?.trend ?? 'unknown'}
            ago={live.minutesAgo === null ? '--' : live.minutesAgo < 1 ? '< 1 min' : `${live.minutesAgo} min`}
            delta={live.status ? fmtDelta(live.status.delta, s.units) : ''}
            stale={stale && snap.glucose.length > 0}
            lifecycle={lifecycle}
            onPress={() => router.push(s.cgmId ? '/cgm-settings' : '/add-cgm')}
          />
          <View style={{ flex: 1, alignItems: 'flex-end' }}>
            <LoopView
              minutesAgo={loopAgo}
              looping={rt.looping}
              closed={closed}
              failed={!!lastRun?.error}
              eventual={lastOk?.suggested?.eventualGlucose !== undefined ? fmtG(lastOk.suggested.eventualGlucose, s.units) : null}
              onPress={() => router.push('/loop')}
            />
          </View>
        </View>

        <MealSlot scrub={scrub} live={{ iob: live.iob.iob, cob: live.cob, now: live.now }} selection={{ glucose: snap.glucose, runs: snap.loopRuns, units: s.units, colors: colorOpts }} />

        {/* Chart with basal capsule and info button */}
        <View style={{ height: chartH }}>
          <MainChart
            c={c}
            now={live.now}
            height={chartH}
            glucose={snap.glucose}
            doses={snap.doses}
            carbs={snap.carbs}
            runs={snap.loopRuns}
            predictions={lastOk?.suggested?.predictions}
            predictionStart={lastOk?.date}
            profile={s.profile}
            units={s.units}
            prefs={prefs}
            override={override}
            tempTarget={tempTarget}
            onScrub={setScrub}
          />
          {rate !== null || rt.pump?.suspended ? (
            <GlassChip style={[styles.rateChip, { top: Math.max(0, (basalBand - 26) / 2) }]}>
              <T style_="subheadline" rounded weight="600" color={c.insulin}>
                {rt.pump?.suspended ? 'Suspended' : `${upTo3(rate!)} U/hr`}
              </T>
            </GlassChip>
          ) : null}
          <Pressable onPress={() => router.push('/legend')} accessibilityRole="button" accessibilityLabel="Chart legend" style={[styles.info, { borderColor: `${c.primary}66` }]}>
            <SymbolView name="info" size={16} tintColor={c.primary} weight="semibold" />
          </Pressable>
        </View>

        {/* Bottom zone: adjustment / bolus panel above the multi-use panel */}
        <View style={{ paddingHorizontal: ZONE_PAD, gap: ZONE_PAD, paddingTop: ZONE_PAD }}>
          {bolus ? <BolusPanel bolus={bolus} /> : <AdjustmentPanel override={override} tempTarget={tempTarget} now={live.now} units={s.units} defaults={adjust} behavior={adjust.behavior} onOpen={() => router.push('/adjustments')} />}
          {multiUse()}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20 },
  rateChip: { position: 'absolute', right: 16, paddingHorizontal: 10, paddingVertical: 3 },
  info: { position: 'absolute', right: 16, bottom: 34, width: 32, height: 32, borderRadius: 16, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
});
