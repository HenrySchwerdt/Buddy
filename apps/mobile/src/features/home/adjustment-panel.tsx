import { Pressable, StyleSheet, View } from 'react-native';
import { SymbolView } from '@/trio/symbol';
import { type ActiveOverride, type ActiveTempTarget, type GlucoseUnit, type TargetBehavior } from '@buddy/core';
import { cancelOverride, cancelTempTarget } from '@/features/adjustments/actions';
import { GlassPanel, T, useTrioColors } from '@/trio';
import { choose } from '@/trio/choice-dialog';
import { overrideText, remainingFraction, tempTargetText } from './adjustment-text';
import { PANEL_H } from './layout';

interface Props {
  readonly override: ActiveOverride | null;
  readonly tempTarget: ActiveTempTarget | null;
  readonly now: number;
  readonly units: GlucoseUnit;
  readonly defaults: { smbMinutes: number; uamMinutes: number };
  readonly behavior: TargetBehavior;
  readonly onOpen: () => void;
}

function Icon({ name, tint }: { name: string; tint: string }) {
  return (
    <View style={[styles.icon, { backgroundColor: `${tint}2E` }]}>
      <SymbolView name={name as never} size={15} tintColor={tint} weight="semibold" />
    </View>
  );
}

function Cancel({ label, onPress }: { label: string; onPress: () => void }) {
  const c = useTrioColors();
  return (
    <Pressable onPress={onPress} hitSlop={8} accessibilityRole="button" accessibilityLabel={label}>
      <SymbolView name="xmark.app" size={28} tintColor={c.primary} />
    </Pressable>
  );
}

function RemainingBar({ fraction, tint }: { fraction: number | null; tint: string }) {
  return <View style={styles.barSlot}>{fraction !== null ? <View style={{ width: `${fraction * 100}%`, height: 4, borderRadius: 15, backgroundColor: tint, opacity: 0.85 }} /> : null}</View>;
}

/** HomeRootView+BottomControls `adjustmentView`: override / temp target / both side by side, remaining-time bar, stop buttons. */
export function AdjustmentPanel({ override, tempTarget, now, units, defaults, behavior, onOpen }: Props) {
  const c = useTrioColors();
  const oText = override ? overrideText(override, now, units, defaults, !!tempTarget) : null;
  const tText = tempTarget ? tempTargetText(tempTarget, now, units, behavior) : null;
  const oFraction = override ? remainingFraction(override.startedAt, override.durationMin, now) : null;
  const tFraction = tempTarget ? remainingFraction(tempTarget.startedAt, tempTarget.durationMin, now) : null;
  const concurrent = !!oText && !!tText;
  const tint = oText ? c.purple : tText ? c.loopGreen : undefined;

  const stopOverride = () =>
    void choose({ title: `Stop the Override "${override?.name ?? ''}"?`, items: [{ label: 'Stop', destructive: true }] }).then((i) => i === 0 && cancelOverride());
  const stopTempTarget = () =>
    void choose({ title: `Stop the Temp Target "${tempTarget?.name ?? ''}"?`, items: [{ label: 'Stop', destructive: true }] }).then((i) => i === 0 && cancelTempTarget());
  const stopEither = () =>
    void choose({
      title: 'Adjustment to Stop',
      message: 'Select Adjustment',
      items: [{ label: 'Stop Override', destructive: true }, { label: 'Stop Temp Target', destructive: true }, { label: 'Stop All Adjustments', destructive: true }],
    }).then((i) => {
      if (i === 0 || i === 2) cancelOverride();
      if (i === 1 || i === 2) cancelTempTarget();
    });

  const text = (t: { title: string; caption: string }) => (
    <View style={{ flex: 1 }}>
      <T style_="subheadline" weight="600" numberOfLines={1}>
        {t.title}
      </T>
      <T style_="caption" secondary numberOfLines={1}>
        {t.caption}
      </T>
    </View>
  );

  return (
    <Pressable onPress={onOpen} accessibilityRole="button" accessibilityHint="Opens adjustments">
      <GlassPanel tint={concurrent ? undefined : tint} tintOpacity={0.12} style={styles.panel}>
        {concurrent ? (
          <View style={[StyleSheet.absoluteFill, { flexDirection: 'row' }]} pointerEvents="none">
            <View style={{ flex: 1, backgroundColor: `${c.purple}1F` }} />
            <View style={{ flex: 1, backgroundColor: `${c.loopGreen}1F` }} />
          </View>
        ) : null}
        <View style={styles.row}>
          {concurrent ? (
            <>
              <View style={[styles.half, { gap: 8 }]}>
                <Icon name="clock.arrow.2.circlepath" tint={c.purple} />
                {text(oText)}
              </View>
              <View style={[styles.half, { gap: 8, paddingLeft: 8 }]}>
                <Icon name="target" tint={c.loopGreen} />
                {text(tText)}
                <Cancel label="Stop adjustment" onPress={stopEither} />
              </View>
            </>
          ) : oText ? (
            <>
              <Icon name="clock.arrow.2.circlepath" tint={c.purple} />
              {text(oText)}
              <Cancel label="Stop override" onPress={stopOverride} />
            </>
          ) : tText ? (
            <>
              <Icon name="target" tint={c.loopGreen} />
              {text(tText)}
              <Cancel label="Stop temp target" onPress={stopTempTarget} />
            </>
          ) : (
            <>
              <Icon name="slider.horizontal.2.gobackward" tint={c.secondary} />
              <View style={{ flex: 1 }}>
                <T style_="subheadline" weight="500" secondary numberOfLines={1}>
                  No Active Adjustment
                </T>
                <T style_="caption" color={c.secondary} style={{ opacity: 0.7 }} numberOfLines={1}>
                  Profile at 100 %
                </T>
              </View>
              <View style={{ width: 28 }} />
            </>
          )}
        </View>
        {concurrent ? (
          <View style={styles.bars}>
            <View style={{ flex: 1 }}>
              <RemainingBar fraction={oFraction} tint={c.purple} />
            </View>
            <View style={{ flex: 1 }}>
              <RemainingBar fraction={tFraction} tint={c.loopGreen} />
            </View>
          </View>
        ) : tint ? (
          <View style={styles.bars}>
            <View style={{ flex: 1 }}>
              <RemainingBar fraction={oText ? oFraction : tFraction} tint={tint} />
            </View>
          </View>
        ) : null}
      </GlassPanel>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  panel: { height: PANEL_H },
  row: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 10 },
  half: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  icon: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  bars: { position: 'absolute', left: 18, right: 18, bottom: 1, flexDirection: 'row', gap: 6 },
  barSlot: { height: 4, justifyContent: 'flex-end' },
});
