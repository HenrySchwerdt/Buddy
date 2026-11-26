import { Pressable, StyleSheet, View } from 'react-native';
import { SymbolView } from '@/trio/symbol';
import type { GlucoseReading, GlucoseUnit } from '@buddy/core';
import { fmtG } from '@/features/format';
import { GlassPanel, T, useTrioColors } from '@/trio';
import { STATS_H } from './layout';
import { averageSubtitle, distributionSegments, gmiString, scopeName, upToOneDecimalPercent, type StatsPanelStats, type StatsFace, type StatsRange } from './stats-panel';

function DistributionBar({ stats }: { stats: StatsPanelStats | null }) {
  const c = useTrioColors();
  const colors = { veryLow: '#FF3B30', low: c.orange, inRange: c.loopGreen, high: c.purple } as const;
  const segments = stats ? distributionSegments(stats).filter((s) => s.fraction > 0.005) : [];
  return (
    <View style={styles.bar}>
      {stats && segments.length > 0 ? segments.map((s) => <View key={s.key} style={{ flex: s.fraction, borderRadius: 3, backgroundColor: colors[s.key] }} />) : <View style={{ flex: 1, borderRadius: 3, backgroundColor: `${c.secondary}4D` }} />}
    </View>
  );
}

interface Props {
  readonly face: StatsFace;
  readonly range: StatsRange;
  readonly stats: StatsPanelStats;
  readonly units: GlucoseUnit;
  readonly a1cUnit: 'percent' | 'mmolMol';
  readonly onPress: () => void;
}

/** HomeRootView+BottomControls `statsBanner`: Time in Range / Distribution Bar / Averages / hidden faces. */
export function StatsBanner({ face, range, stats, units, a1cUnit, onPress }: Props) {
  const c = useTrioColors();
  const hasData = stats.mean !== null;
  const tir = hasData ? upToOneDecimalPercent(stats.inRangePct) : '--';
  const subtitle = (
    <T style_="subheadline" secondary numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8} style={{ flexShrink: 1 }}>
      <T style_="subheadline" secondary weight="600">
        Time in Range
      </T>{' '}
      {scopeName(range)}
    </T>
  );
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel="Statistics">
      <GlassPanel style={styles.panel}>
        <View style={styles.row}>
          {face === 'timeInRange' ? (
            <View style={{ flex: 1, gap: 4 }}>
              <View style={styles.baseline}>
                <T style_="title2" rounded weight="700">
                  {tir}
                </T>
                {subtitle}
              </View>
              <DistributionBar stats={hasData ? stats : null} />
            </View>
          ) : face === 'distributionBar' ? (
            <View style={{ flex: 1, gap: 6 }}>
              {subtitle}
              <DistributionBar stats={hasData ? stats : null} />
            </View>
          ) : face === 'averages' ? (
            <View style={{ flex: 1, gap: 6 }}>
              <T style_="subheadline" weight="600" numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>
                Avg. Glucose: {hasData ? `${fmtG(stats.mean, units)} ${units}` : '--'} {'·'} GMI {gmiString(stats.mean, a1cUnit)}
              </T>
              <T style_="caption" secondary>
                {averageSubtitle(range)}
              </T>
            </View>
          ) : (
            <T style_="subheadline" weight="600" secondary style={{ flex: 1 }}>
              View Statistics
            </T>
          )}
          <SymbolView name="chevron.right" size={15} tintColor={c.secondary} weight="semibold" />
        </View>
      </GlassPanel>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  panel: { height: STATS_H },
  row: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16 },
  baseline: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  bar: { height: 6, flexDirection: 'row', gap: 2 },
});
