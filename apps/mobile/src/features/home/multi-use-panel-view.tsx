import { Pressable, StyleSheet, View } from 'react-native';
import { SymbolView } from '@/trio/symbol';
import { GlassPanel, T, useTrioColors } from '@/trio';
import { STATS_H } from './layout';

interface BannerProps {
  readonly icon: string;
  readonly title: string;
  readonly subtitle: string;
  readonly tint: string;
  readonly critical?: boolean;
  readonly onPress: () => void;
}

/** `panelBanner`: tinted glass strip with icon, title, subtitle and chevron (critical = stronger tint). */
export function PanelBanner({ icon, title, subtitle, tint, critical, onPress }: BannerProps) {
  const c = useTrioColors();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${title}. ${subtitle}`}>
      <GlassPanel tint={tint} tintOpacity={critical ? 0.3 : 0.12} style={[styles.panel, critical ? { borderWidth: 1.5, borderColor: `${tint}CC` } : null]}>
        <View style={styles.row}>
          <View style={[styles.icon, { backgroundColor: `${tint}2E` }]}>
            <SymbolView name={icon as never} size={15} tintColor={tint} weight="semibold" />
          </View>
          <View style={{ flex: 1 }}>
            <T style_="subheadline" weight="600" numberOfLines={1}>
              {title}
            </T>
            <T style_="caption" secondary numberOfLines={1}>
              {subtitle}
            </T>
          </View>
          <SymbolView name="chevron.right" size={15} tintColor={c.secondary} weight="semibold" />
        </View>
      </GlassPanel>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  panel: { height: STATS_H },
  row: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16 },
  icon: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
});
