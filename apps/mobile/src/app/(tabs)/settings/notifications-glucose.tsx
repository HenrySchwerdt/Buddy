import type { AlertKind } from '@buddy/core';
import { router } from 'expo-router';
import { useState } from 'react';
import { Switch } from 'react-native';
import { GLUCOSE_ALARMS, isEnabled } from '@/features/settings-b/alarm-catalog';
import { AlarmEditorSheet } from '@/features/settings-b/alarm-editor';
import { AlarmRow } from '@/features/settings-b/alarm-row';
import { HintParagraphs, HintSheet, TintedNavRow, ToggleWithHint, useHint } from '@/features/settings-b/ui';
import { useSettings } from '@/runtime/settings-store';
import { Row, Section, T, TrioScreen, useTrioColors } from '@/trio';

/** Trio GlucoseAlerts.RootView. Buddy has one fixed alarm per type (no add / delete). */
export default function GlucoseAlarmsScreen() {
  const c = useTrioColors();
  const alerts = useSettings((s) => s.alerts);
  const units = useSettings((s) => s.units);
  const [editing, setEditing] = useState<AlertKind | null>(null);
  const help = useHint();

  const enabled = GLUCOSE_ALARMS.filter((m) => isEnabled(m.kind, alerts));
  const disabled = GLUCOSE_ALARMS.filter((m) => !isEnabled(m.kind, alerts));

  return (
    <TrioScreen back inlineTitle="Glucose Alarms">
      {enabled.length ? (
        <Section header="Enabled">
          {enabled.map((m) => (
            <AlarmRow key={m.kind} meta={m} alerts={alerts} units={units} onPress={() => setEditing(m.kind)} />
          ))}
        </Section>
      ) : null}
      {disabled.length ? (
        <Section header="Disabled">
          {disabled.map((m) => (
            <AlarmRow key={m.kind} meta={m} alerts={alerts} units={units} dimmed onPress={() => setEditing(m.kind)} />
          ))}
        </Section>
      ) : null}

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
          value={false}
          disabled
          onChange={() => {}}
          miniHint="Show your current glucose on Buddy app icon. Not available yet."
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

      <AlarmEditorSheet kind={editing} variant="glucose" onClose={() => setEditing(null)} />
      <HintSheet hint={help.hint} onClose={help.close} />
    </TrioScreen>
  );
}
