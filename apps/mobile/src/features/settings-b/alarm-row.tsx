import type { AlertSettings, GlucoseUnit } from '@buddy/core';
import { SymbolView } from '@/trio/symbol';
import { View } from 'react-native';
import { Row, T, useTrioColors } from '@/trio';
import { activeWindow, alarmSummary, overridesFocus, type AlarmMeta } from './alarm-catalog';
import { WindowIcon } from './ui';

/** Row of GlucoseAlertsRootView / DeviceAlarmsRootView: window icon, name, summary, sound line. */
export function AlarmRow({ meta, alerts, units, dimmed, onPress }: { meta: AlarmMeta; alerts: AlertSettings; units: GlucoseUnit; dimmed?: boolean; onPress: () => void }) {
  const c = useTrioColors();
  const summary = alarmSummary(meta, alerts, units);
  return (
    <Row onPress={onPress} accessibilityLabel={`${meta.name}, ${summary}`} style={dimmed ? { opacity: 0.6 } : undefined}>
      <WindowIcon option={activeWindow(meta.kind, alerts.quietHours)} />
      <View style={{ flex: 1, gap: 2 }}>
        <T>{meta.name}</T>
        <T style_="footnote" secondary>
          {summary}
        </T>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <SymbolView name="speaker.wave.2.fill" size={12} tintColor={c.secondary} />
            <T style_="footnote" secondary>
              Sound on
            </T>
          </View>
          {overridesFocus(meta.kind) ? (
            <>
              <T style_="footnote" secondary>
                ·
              </T>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <SymbolView name="bell.badge.fill" size={12} tintColor={c.secondary} />
                <T style_="footnote" secondary>
                  Overrides Focus
                </T>
              </View>
            </>
          ) : null}
        </View>
      </View>
      <SymbolView name="chevron.right" size={13} tintColor={c.secondary} weight="semibold" />
    </Row>
  );
}
