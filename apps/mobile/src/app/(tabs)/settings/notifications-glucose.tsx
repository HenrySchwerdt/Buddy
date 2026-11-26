import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { useState } from 'react';
import { Switch } from 'react-native';
import { GlucoseAlarmsList } from '@/features/settings-b/glucose-alarms-list';
import { HintParagraphs, HintSheet, TintedNavRow, ToggleWithHint, useHint } from '@/features/settings-b/ui';
import { useSettings } from '@/runtime/settings-store';
import { CapsuleButton, Row, Section, T, TrioScreen, useTrioColors } from '@/trio';

/** Trio GlucoseAlerts.RootView. Buddy has one fixed alarm per type (no add / delete). */
export default function GlucoseAlarmsScreen() {
  const c = useTrioColors();
  const badge = useSettings((s) => s.glucoseBadge);
  const update = useSettings((s) => s.update);
  const [adding, setAdding] = useState(false);
  const help = useHint();

  return (
    <TrioScreen back inlineTitle="Glucose Alarms" trailing={<CapsuleButton icon="plus" onPress={() => setAdding(true)} accessibilityLabel="Add alarm" />}>
      <GlucoseAlarmsList adding={adding} onAddingChange={setAdding} />

      <Section>
        <TintedNavRow label="Day & Night Windows" color={c.accent} onPress={() => router.push('/settings/notifications-windows')} />
      </Section>

      <Section footer="Your CGM has no companion app, so Buddy handles alarms.">
        <Row accessibilityLabel="Use CGM App Alerts, off">
          <T style={{ flex: 1 }} color={c.secondary}>
            Use CGM App Alerts
          </T>
          <Switch value={false} disabled trackColor={{ true: c.tabBar }} />
        </Row>
      </Section>

      <Section header="Glucose App Badge">
        <ToggleWithHint
          label="Show Glucose App Badge"
          value={badge}
          onChange={(v) => {
            if (v) void Notifications.requestPermissionsAsync({ ios: { allowBadge: true } }).catch(() => {});
            update({ glucoseBadge: v });
          }}
          miniHint="Show your current glucose on Buddy app icon."
          onHelp={() =>
            help.show({
              label: 'Show Glucose App Badge',
              body: (
                <HintParagraphs
                  boldFirst
                  lines={['Default: OFF', 'This will add your current glucose on the top right of your Buddy icon as a red notification badge. Changing setting takes effect on next Glucose reading.']}
                />
              ),
            })
          }
        />
      </Section>

      <HintSheet hint={help.hint} onClose={help.close} />
    </TrioScreen>
  );
}
