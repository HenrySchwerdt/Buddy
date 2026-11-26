import { View } from 'react-native';
import type { GlucoseUnit } from '@buddy/core';
import { Row, T, useTrioColors } from '@/trio';
import { SymbolView } from '@/trio/symbol';
import { overridesFocus } from './alarm-catalog';
import { soundName } from './alarm-sounds';
import { alarmSummaryOf, type GlucoseAlarm } from './alarms';
import { WindowIcon } from './ui';

/** Row of GlucoseAlertsRootView: window icon, name, summary and the sound line. */
export function GlucoseAlarmRow({ alarm, units, dimmed, onPress }: { alarm: GlucoseAlarm; units: GlucoseUnit; dimmed?: boolean; onPress: () => void }) {
  const c = useTrioColors();
  const summary = alarmSummaryOf(alarm, units);
  return (
    <Row onPress={onPress} accessibilityLabel={`${alarm.name}, ${summary}`} style={dimmed ? { opacity: 0.6 } : undefined}>
      <WindowIcon option={alarm.window} />
      <View style={{ flex: 1, gap: 2 }}>
        <T>{alarm.name}</T>
        <T style_="footnote" secondary>
          {summary}
        </T>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <SymbolView name={alarm.playsSound ? 'speaker.wave.2.fill' : 'speaker.slash.fill'} size={12} tintColor={c.secondary} />
            <T style_="footnote" secondary>
              {alarm.playsSound ? soundName(alarm.soundId) : 'No sound'}
            </T>
          </View>
          {overridesFocus(alarm.kind) ? (
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
