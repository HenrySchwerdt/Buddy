import type { AlertKind } from '@buddy/core';
import { router } from 'expo-router';
import { SymbolView, type SFSymbol } from '@/trio/symbol';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { DEVICE_ALARMS, isEnabled } from '@/features/settings-b/alarm-catalog';
import { AlarmEditorSheet } from '@/features/settings-b/alarm-editor';
import { AlarmRow } from '@/features/settings-b/alarm-row';
import { HintSheet, TintedNavRow, useHint } from '@/features/settings-b/ui';
import { useSettings } from '@/runtime/settings-store';
import { Row, Section, T, TrioScreen, useTrioColors } from '@/trio';

type Tier = 'critical' | 'timeSensitive' | 'normal';

/** Trio's DeviceAlertSeverity copy. */
const TIERS: readonly { tier: Tier; name: string; icon: SFSymbol; blurb: string; hint: string; kinds: readonly AlertKind[] }[] = [
  {
    tier: 'critical',
    name: 'Critical',
    icon: 'exclamationmark.triangle.fill',
    blurb: 'Overrides Silence & Focus Mode. For situations requiring immediate attention.',
    hint: 'For situations that require prompt attention. These break through Silent Mode, Do Not Disturb, and any Focus you have enabled. Examples: an empty reservoir, or Buddy not looping for too long. Heads up: if your build of Buddy has Apple’s Critical Alerts entitlement, iOS plays its own critical alert sound.',
    // Both escalate to a critical alert (not looping past "Critical After", reservoir empty).
    kinds: ['notLooping', 'pumpReservoirLow'],
  },
  {
    tier: 'timeSensitive',
    name: 'Time-Sensitive',
    icon: 'bell.badge.fill',
    blurb: 'Pierces banner suppression but obeys Silence & Focus Mode by default.',
    hint: 'For things you should know about soon, but not ‘act right now’. These can break through banner suppression on the lock screen, but they still obey Silent Mode and Focus by default. Examples: reservoir running low, pump battery low, or glucose data going stale.',
    kinds: ['staleData', 'pumpBatteryLow'],
  },
  {
    tier: 'normal',
    name: 'Normal',
    icon: 'bell.fill',
    blurb: 'Default notification banner. Suppressed by Silence & Focus Mode by default.',
    hint: 'For everyday heads-up notifications. These behave like a standard banner — they stay quiet when your phone is silenced or a Focus is on.',
    kinds: [],
  },
];

/** Trio DeviceAlarms.RootView, grouped by severity tier. */
export default function DeviceAlarmsScreen() {
  const c = useTrioColors();
  const alerts = useSettings((s) => s.alerts);
  const units = useSettings((s) => s.units);
  const [editing, setEditing] = useState<AlertKind | null>(null);
  const help = useHint();
  const tint: Record<Tier, string> = { critical: c.red, timeSensitive: c.orange, normal: c.accent };

  return (
    <TrioScreen back inlineTitle="Device Alarms">
      {TIERS.map((t) => (
        <Section key={t.tier}>
          <View style={{ paddingHorizontal: 20, paddingTop: 14, gap: 5 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <SymbolView name={t.icon} size={18} tintColor={tint[t.tier]} />
              <T style_="headline">{t.name}</T>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 }}>
              <T style_="footnote" secondary style={{ flex: 1 }}>
                {t.blurb}
              </T>
              <Pressable hitSlop={10} accessibilityRole="button" accessibilityLabel="More information" onPress={() => help.show({ label: `${t.name} Device Alerts`, body: t.hint })}>
                <SymbolView name="questionmark.circle" size={20} tintColor={c.tabBar} />
              </Pressable>
            </View>
          </View>
          {t.kinds.length === 0 ? (
            <Row>
              <T style_="footnote" secondary>
                No Buddy alarms use this tier.
              </T>
            </Row>
          ) : null}
          {DEVICE_ALARMS.filter((m) => t.kinds.includes(m.kind)).map((m) => (
            <AlarmRow key={m.kind} meta={m} alerts={alerts} units={units} dimmed={!isEnabled(m.kind, alerts)} onPress={() => setEditing(m.kind)} />
          ))}
        </Section>
      ))}

      <Section>
        <TintedNavRow label="Day & Night Windows" color={c.accent} onPress={() => router.push('/settings/notifications-windows')} />
      </Section>

      <AlarmEditorSheet kind={editing} variant="device" onClose={() => setEditing(null)} />
      <HintSheet hint={help.hint} onClose={help.close} />
    </TrioScreen>
  );
}
