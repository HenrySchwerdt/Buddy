import { router } from 'expo-router';
import { SymbolView } from '@/trio/symbol';
import { useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { computeIob, isOverrideActive, isTempTargetActive, scheduleValueAt, MINUTE } from '@buddy/core';
import { dayStats } from '@/features/day-stats';
import { fmtDelta, fmtG, fmtTime, fmtU } from '@/features/format';
import { GlucoseBobble, LoopView, PumpView } from '@/features/home/header';
import { MainChart } from '@/features/home/main-chart';
import { useLiveState, useSnapshot } from '@/runtime/hooks';
import { runLoop, useRuntime } from '@/runtime/runtime';
import { useSettings } from '@/runtime/settings-store';
import { GlassChip, GlassPanel, T, TAB_BAR_SPACE, TrioBackground, trioGlucoseColor, useTrioColors } from '@/trio';

/** Fixed zone heights from Trio's HomeLayout; the chart takes the rest. */
const HEADER_H = 172;
const MEAL_H = 44;
const PANEL_H = 60;
const ZONE_PAD = 10;
const BOTTOM_ZONE = PANEL_H * 2 + ZONE_PAD * 3;
const LOW = 70;
const HIGH = 180;

/** Home dashboard — 1:1 layout of Trio dev's HomeRootView. Pull down to force a loop. */
export default function HomeScreen() {
  const c = useTrioColors();
  const insets = useSafeAreaInsets();
  const [h, setH] = useState(0);
  const [scrub, setScrub] = useState<number | null>(null);
  const snap = useSnapshot();
  const live = useLiveState();
  const rt = useRuntime();
  const s = useSettings();

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
  const stats = useMemo(() => dayStats(snap.glucose, live.now), [snap.glucose, live.now]);
  const chartH = Math.max(140, h - HEADER_H - MEAL_H - BOTTOM_ZONE - TAB_BAR_SPACE + 6);

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
            <PumpView
              hasPump={!!rt.pump}
              reservoir={rt.pump?.reservoirUnits ?? null}
              battery={rt.pump?.batteryPercent ?? null}
              onPress={() => router.push(rt.pump ? '/pump-settings' : '/add-pump')}
            />
          </View>
          <GlucoseBobble
            empty={!s.cgmId}
            value={bg === null ? '--' : fmtG(bg, s.units)}
            color={bg === null ? c.primary : trioGlucoseColor(c, bg, LOW, HIGH)}
            trend={live.last?.trend ?? 'unknown'}
            ago={live.minutesAgo === null ? '--' : live.minutesAgo < 1 ? '< 1 min' : `${live.minutesAgo} min`}
            delta={live.status ? fmtDelta(live.status.delta, s.units) : ''}
            stale={stale && snap.glucose.length > 0}
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

        {/* Meal slot: IOB / COB / alarms, or the chart readout while scrubbing */}
        <View style={[styles.meal, { height: MEAL_H }]}>
          {scrub === null ? (
            <>
              <View style={styles.mealItem} accessible accessibilityLabel={`Insulin on board ${fmtU(live.iob.iob)} units`}>
                <SymbolView name="syringe.fill" size={22} tintColor={c.insulin} />
                <T style_="callout" rounded weight="700" size={18}>
                  {fmtIob(live.iob.iob)} U
                </T>
              </View>
              <View style={styles.mealItem} accessible accessibilityLabel={`Carbs on board ${Math.round(live.cob)} grams`}>
                <SymbolView name="fork.knife" size={22} tintColor={c.carbs} />
                <T style_="callout" rounded weight="700" size={18}>
                  {Math.round(live.cob)} g
                </T>
              </View>
              <View style={{ flex: 1 }} />
              <Pressable onPress={() => router.push('/settings/notifications')} accessibilityRole="button" accessibilityLabel="Alarms" style={[styles.bell, { borderColor: c.secondary }]}>
                <SymbolView name="bell.fill" size={18} tintColor={c.primary} />
              </Pressable>
            </>
          ) : (
            <ScrubReadout t={scrub} />
          )}
        </View>

        {/* Chart with basal capsule and info button */}
        <View style={{ height: chartH }}>
          <MainChart
            c={c}
            now={live.now}
            height={chartH}
            hoursBack={6}
            glucose={snap.glucose}
            doses={snap.doses}
            carbs={snap.carbs}
            predictions={lastOk?.suggested?.predictions}
            predictionStart={lastOk?.date}
            profile={s.profile}
            units={s.units}
            low={LOW}
            high={HIGH}
            onScrub={setScrub}
          />
          {rate !== null || rt.pump?.suspended ? (
            <GlassChip style={styles.rateChip}>
              <T style_="subheadline" rounded weight="600" color={temp ? c.insulin : c.insulin}>
                {rt.pump?.suspended ? 'Suspended' : `${fmtU(rate, rate! < 1 ? 1 : 2)} U/hr`}
              </T>
            </GlassChip>
          ) : null}
          <Pressable onPress={() => router.push('/legend')} accessibilityRole="button" accessibilityLabel="Chart legend" style={[styles.info, { borderColor: c.secondary }]}>
            <SymbolView name="info" size={18} tintColor={c.primary} weight="bold" />
          </Pressable>
        </View>

        {/* Bottom zone: adjustment panel + multi-use stats banner */}
        <View style={{ paddingHorizontal: ZONE_PAD, gap: ZONE_PAD, paddingTop: ZONE_PAD }}>
          <Pressable onPress={() => router.push('/adjustments')} accessibilityRole="button">
            <GlassPanel tint={override ? c.zt : tempTarget ? c.loopGreen : undefined} style={styles.panel}>
              <View style={[styles.panelIcon, { backgroundColor: c.fill }]}>
                <SymbolView name="slider.horizontal.2.gobackward" size={18} tintColor={override || tempTarget ? c.primary : c.secondary} />
              </View>
              <View style={{ flex: 1 }}>
                <T style_="headline" weight="500" secondary={!override && !tempTarget} numberOfLines={1}>
                  {override ? override.name : tempTarget ? tempTarget.name : 'No Active Adjustment'}
                </T>
                <T style_="subheadline" secondary numberOfLines={1}>
                  {override
                    ? `${override.percentage} %${override.target ? ` · ${fmtG(override.target, s.units)} ${s.units}` : ''} · ${override.durationMin === null ? 'Indefinitely' : `until ${fmtTime(override.startedAt + override.durationMin * MINUTE)}`}`
                    : tempTarget
                      ? `${fmtG(tempTarget.target, s.units)} ${s.units} · until ${fmtTime(tempTarget.startedAt + tempTarget.durationMin * MINUTE)}`
                      : 'Profile at 100 %'}
                </T>
              </View>
            </GlassPanel>
          </Pressable>
          <Pressable onPress={() => router.push('/statistics')} accessibilityRole="button">
            {stats ? (
              <GlassPanel style={styles.panel}>
                <View style={{ flex: 1, gap: 6 }}>
                  <View style={styles.statsLine}>
                    <T style_="subheadline" secondary>
                      Time in Range
                    </T>
                    <T style_="headline" rounded color={c.loopGreen}>
                      {Math.round(stats.tir)} %
                    </T>
                  </View>
                  <View style={[styles.tirBar, { backgroundColor: c.fill }]}>
                    <View style={{ flex: stats.tbr70, backgroundColor: c.loopRed }} />
                    <View style={{ flex: stats.tir, backgroundColor: c.loopGreen }} />
                    <View style={{ flex: stats.tar180, backgroundColor: c.loopYellow }} />
                  </View>
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <T style_="caption" secondary>
                    Average
                  </T>
                  <T style_="headline" rounded>
                    {fmtG(stats.mean, s.units)}
                  </T>
                </View>
              </GlassPanel>
            ) : (
              <GlassPanel tint={c.orange} style={styles.panel}>
                <View style={[styles.panelIcon, { backgroundColor: `${c.orange}33` }]}>
                  <SymbolView name="drop.fill" size={18} tintColor={c.orange} />
                </View>
                <View style={{ flex: 1 }}>
                  <T style_="headline" weight="500">
                    No Recent Glucose
                  </T>
                  <T style_="subheadline" secondary>
                    Tap to add a fingerstick reading.
                  </T>
                </View>
                <SymbolView name="chevron.right" size={14} tintColor={c.secondary} />
              </GlassPanel>
            )}
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}

const fmtIob = (u: number) => (Math.abs(u) < 0.005 ? '0' : u.toFixed(2).replace(/0$/, ''));

function ScrubReadout({ t }: { t: number }) {
  const c = useTrioColors();
  const snap = useSnapshot();
  const { profile, units } = useSettings();
  const reading = snap.glucose.reduce<(typeof snap.glucose)[number] | null>((b, g) => (!b || Math.abs(g.date - t) < Math.abs(b.date - t) ? g : b), null);
  const iob = computeIob(snap.doses.filter((d) => d.date <= t), profile, t).iob;
  return (
    <>
      <T style_="callout" rounded weight="700" secondary>
        {fmtTime(t)}
      </T>
      <T style_="callout" rounded weight="700" color={reading ? trioGlucoseColor(c, reading.value, LOW, HIGH) : c.primary}>
        {fmtG(reading?.value, units)} {units}
      </T>
      <View style={styles.mealItem}>
        <SymbolView name="syringe.fill" size={18} tintColor={c.insulin} />
        <T style_="callout" rounded weight="700">
          {fmtIob(iob)} U
        </T>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20 },
  meal: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, gap: 28 },
  mealItem: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  bell: { width: 34, height: 34, borderRadius: 17, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  rateChip: { position: 'absolute', top: 6, right: 16, paddingHorizontal: 10, paddingVertical: 4 },
  info: { position: 'absolute', right: 16, bottom: 34, width: 34, height: 34, borderRadius: 17, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  panel: { height: PANEL_H, flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 14 },
  panelIcon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  statsLine: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  tirBar: { height: 8, borderRadius: 4, overflow: 'hidden', flexDirection: 'row' },
});
