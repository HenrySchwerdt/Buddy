import { Pressable, View } from 'react-native';
import type { GlucoseUnit } from '@buddy/core';
import { T, useTrioColors } from '@/trio';
import { PERCENTILE_KEYS, type PercentileKey, type PercentileSummary } from './calc';
import { SYS, alpha, glucoseValue } from './format';

/** GlucoseDailyPercentileDetailView: date line over seven tappable percentile tiles. */
export function GlucosePercentileDetail({
  data,
  title,
  units,
  selected,
  onSelect,
}: {
  readonly data: PercentileSummary | null;
  readonly title: string;
  readonly units: GlucoseUnit;
  readonly selected: PercentileKey | null;
  readonly onSelect: (key: PercentileKey | null) => void;
}) {
  const c = useTrioColors();
  return (
    <View style={{ alignItems: 'center', gap: 8 }}>
      <T style_="subheadline" weight="500" align="center">
        {title}
      </T>
      {data ? (
        <View style={{ flexDirection: 'row', paddingVertical: 8 }}>
          {PERCENTILE_KEYS.map(({ key, label }) => {
            const on = key === selected;
            const value = glucoseValue(data[key], units);
            return (
              <Pressable
                key={key}
                onPress={() => onSelect(on ? null : key)}
                accessibilityRole="button"
                accessibilityLabel={label}
                accessibilityValue={{ text: value }}
                accessibilityState={{ selected: on }}
                style={{ flex: 1, alignItems: 'center', gap: 2, padding: 4, borderRadius: 4, borderWidth: 1, borderColor: on ? SYS.purple : 'transparent', backgroundColor: on ? alpha(SYS.purple, 0.1) : 'transparent' }}>
                <T style_="callout" color={on ? SYS.purple : c.primary} style={{ fontVariant: ['tabular-nums'] }}>
                  {value}
                </T>
                <T style_="caption2" color={on ? SYS.purple : c.secondary}>
                  {label}
                </T>
              </Pressable>
            );
          })}
        </View>
      ) : (
        <T secondary style={{ padding: 16 }}>
          No glucose data available for this day
        </T>
      )}
    </View>
  );
}
