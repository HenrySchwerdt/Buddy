import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { MINUTE } from '@buddy/core';
import { fmtTime } from '@/features/format';
import { useSnapshot } from '@/runtime/hooks';
import { currentAlgorithm, useRuntime } from '@/runtime/runtime';
import { useSettings } from '@/runtime/settings-store';
import { T, TrioBackground, useTrioColors } from '@/trio';

/** LoopStatusView port: status badge, dosing mode, summary, failure details, reasoning. */
export default function LoopStatusSheet() {
  const c = useTrioColors();
  const runs = useSnapshot().loopRuns;
  const now = useRuntime((r) => r.now);
  const blocked = useRuntime((r) => r.closedLoopBlocked);
  const mode = useSettings((s) => s.loopMode);
  const closed = mode === 'closed' && !blocked;
  const last = runs.at(-1);
  const lastOk = [...runs].reverse().find((r) => !r.error);
  const fresh = lastOk && now - lastOk.date < 15 * MINUTE;
  const enacted = lastOk?.enacted && (lastOk.enacted.tempBasal !== undefined || lastOk.enacted.autoBolus);
  const title = !lastOk
    ? 'No recent determination.'
    : !fresh
      ? `Buddy has not looped in ${Math.round((now - lastOk.date) / MINUTE)} minutes.`
      : enacted
        ? `Enacted at ${fmtTime(lastOk.date)}`
        : `Determined at ${fmtTime(lastOk.date)}`;
  const badge = !lastOk || !fresh ? (lastOk ? c.loopRed : c.loopGreen) : c.loopGreen;
  const summary = !closed ? 'Buddy worked this out but did not send anything to your pump.' : null;
  const reason = lastOk?.suggested?.reason;

  return (
    <View style={{ flex: 1 }}>
      <TrioBackground />
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.titleRow}>
          <T weight="700" style={{ fontSize: 19, flex: 1 }}>
            Current Loop Status
          </T>
          <SymbolView name="questionmark.circle" size={22} tintColor={c.tabBar} />
        </View>
        <View style={[styles.badge, { backgroundColor: badge }]}>
          <T style_="headline" color="#0B1726">
            {title}
          </T>
        </View>
        <View style={styles.modeRow}>
          <SymbolView name={closed ? 'circle.circle' : 'circle.dashed'} size={20} tintColor={c.primary} />
          <T style_="subheadline" weight="600" style={{ fontSize: 17 }}>
            {closed ? 'Closed Loop' : 'Open Loop'}
          </T>
        </View>
        {summary && lastOk ? <T style_="subheadline">{summary}</T> : null}
        {last?.error ? (
          <View style={{ gap: 4 }}>
            <T style_="headline">Loop at {fmtTime(last.date)} failed.</T>
            <T style_="caption" secondary>
              {last.error}
            </T>
          </View>
        ) : null}
        {reason ? (
          <View style={{ gap: 8 }}>
            <T weight="700" style={{ marginTop: 8 }}>
              Current Algorithm Reasoning
            </T>
            <T style_="caption" secondary>
              {currentAlgorithm().meta.name}
            </T>
            <T style_="subheadline">{reason}</T>
          </View>
        ) : !lastOk ? (
          <T style={{ fontSize: 17 }}>No recent oref algorithm determination.</T>
        ) : null}
        <Pressable onPress={() => router.back()} accessibilityRole="button" style={({ pressed }) => [styles.got, { backgroundColor: c.dark ? '#1C2A4A' : '#E5E8F5', opacity: pressed ? 0.7 : 1 }]}>
          <T weight="700" color={c.tabBar}>
            Got it!
          </T>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, paddingTop: 28, gap: 14 },
  titleRow: { flexDirection: 'row', alignItems: 'center' },
  badge: { alignSelf: 'flex-start', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999 },
  modeRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  got: { marginTop: 32, height: 50, borderRadius: 25, alignItems: 'center', justifyContent: 'center' },
});
