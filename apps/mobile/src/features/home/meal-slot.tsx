import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { SymbolView } from '@/trio/symbol';
import { MINUTE, type GlucoseReading, type GlucoseUnit, type LoopRun } from '@buddy/core';
import { fmtG, fmtTime } from '@/features/format';
import { SnoozeAlertsSheet } from '@/features/settings-b/snooze-sheet';
import { snoozedUntil } from '@/features/settings-b/snooze';
import { GlassPanel, T, useTrioColors } from '@/trio';
import { useSettings } from '@/runtime/settings-store';
import { glucoseColor, type GlucoseColorOptions } from './glucose-color';
import { MEAL_H } from './layout';

/** ChartSelectionLookup.window: half-width of the lookup around a scrub time. */
const WINDOW_MS = 150_000;
const twoDigits = (v: number) => String(Number(v.toFixed(2)));

/** Snooze countdown in whole minutes, rounded up (`alarmsPill`). */
export const snoozeMinutesLeft = (until: number, now: number) => Math.max(Math.ceil((until - now) / MINUTE), 0);

interface LiveProps {
  readonly iob: number;
  readonly cob: number;
  readonly now: number;
}

/** liveMealPanel: IOB left, COB on the midline, alarms pill right. */
function LiveRow({ iob, cob, now }: LiveProps) {
  const c = useTrioColors();
  const snoozes = useSettings((s) => s.alertSnoozes);
  const [sheet, setSheet] = useState(false);
  const until = snoozedUntil(snoozes, now);
  const minutes = until === null ? 0 : snoozeMinutesLeft(until, now);
  return (
    <View style={styles.live}>
      <View style={styles.cobCenter} pointerEvents="none" accessible accessibilityLabel="Carbs on board" accessibilityValue={{ text: `${twoDigits(cob)} g` }}>
        <View style={styles.item}>
          <SymbolView name="fork.knife" size={16} tintColor={c.loopYellow} />
          <T style_="callout" rounded weight="700">
            {twoDigits(cob)} g
          </T>
        </View>
      </View>
      <View style={styles.item} accessible accessibilityLabel="Insulin on board" accessibilityValue={{ text: `${twoDigits(iob)} U` }}>
        <SymbolView name="syringe.fill" size={16} tintColor={c.insulin} />
        <T style_="callout" rounded weight="700">
          {twoDigits(iob)} U
        </T>
      </View>
      <View style={{ flex: 1 }} />
      <Pressable onPress={() => setSheet(true)} accessibilityRole="button" accessibilityLabel="Alarms" accessibilityValue={{ text: until === null ? 'active' : `snoozed, ${minutes} minutes remaining` }} accessibilityHint="Opens snooze options">
        {until !== null ? (
          <View style={[styles.pillSnoozed, { borderColor: `${c.primary}66` }]}>
            <SymbolView name="bell.slash.fill" size={16} tintColor={c.secondary} />
            <T style_="callout" rounded weight="700" secondary>
              {minutes} m
            </T>
          </View>
        ) : (
          <View style={[styles.bell, { borderColor: `${c.primary}66` }]}>
            <SymbolView name="bell.fill" size={16} tintColor={c.primary} />
          </View>
        )}
      </Pressable>
      <SnoozeAlertsSheet visible={sheet} onClose={() => setSheet(false)} />
    </View>
  );
}

interface SelectionProps {
  readonly t: number;
  readonly glucose: readonly GlucoseReading[];
  readonly runs: readonly LoopRun[];
  readonly units: GlucoseUnit;
  readonly colors: GlucoseColorOptions;
}

const nearest = <T extends { date: number }>(items: readonly T[], t: number): T | null => items.reduce<T | null>((b, g) => (!b || Math.abs(g.date - t) < Math.abs(b.date - t) ? g : b), null);

/** ChartSelectionRow: time, reading, IOB and COB of the determination nearest the scrub. */
function SelectionRow({ t, glucose, runs, units, colors }: SelectionProps) {
  const c = useTrioColors();
  const reading = nearest(glucose, t);
  const readingNear = reading && Math.abs(reading.date - t) <= WINDOW_MS ? reading : null;
  const run = nearest(runs, t);
  const runNear = run && Math.abs(run.date - t) <= WINDOW_MS ? run : null;
  const tint = readingNear ? glucoseColor(readingNear.value, colors) : c.primary;
  const dash = (
    <T style_="callout" rounded weight="700" secondary>
      {' – '}
    </T>
  );
  const item = (icon: string, color: string, value: React.ReactNode) => (
    <View style={styles.item}>
      <SymbolView name={icon as never} size={13} tintColor={color} />
      {value}
    </View>
  );
  return (
    <GlassPanel tint={tint} tintOpacity={0.1} radius={20} style={styles.selection}>
      <View style={styles.selectionRow}>
        {item('clock', c.secondary, <T style_="callout" rounded weight="700">{fmtTime(readingNear?.date ?? t)}</T>)}
        {item('drop.fill', tint, <T style_="callout" rounded weight="700" color={tint}>{readingNear ? fmtG(readingNear.value, units) : '–'}</T>)}
        {item('syringe.fill', c.insulin, runNear ? <T style_="callout" rounded weight="700">{twoDigits(runNear.iob)} U</T> : dash)}
        {item('fork.knife', c.loopYellow, runNear ? <T style_="callout" rounded weight="700">{Math.round(runNear.cob)} g</T> : dash)}
      </View>
    </GlassPanel>
  );
}

/** Meal slot: the live row, or the chart readout while scrubbing (the readout wins; it answers the same questions for another instant). */
export function MealSlot({ scrub, live, selection }: { scrub: number | null; live: LiveProps; selection: Omit<SelectionProps, 't'> }) {
  return <View style={styles.slot}>{scrub === null ? <LiveRow {...live} /> : <SelectionRow t={scrub} {...selection} />}</View>;
}

const styles = StyleSheet.create({
  slot: { height: MEAL_H, justifyContent: 'center', paddingHorizontal: 16 },
  live: { flexDirection: 'row', alignItems: 'center' },
  cobCenter: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  item: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  bell: { width: 32, height: 32, borderRadius: 16, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  pillSnoozed: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 5, paddingHorizontal: 10, borderRadius: 999, borderWidth: 2 },
  selection: { alignSelf: 'center', paddingHorizontal: 12, paddingVertical: 5 },
  selectionRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
});
