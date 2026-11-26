import { useEffect, useState } from 'react';
import { Linking, Platform } from 'react-native';
import { healthGlucoseWritable, healthLabel, requestHealthPermission } from '@/runtime/health/health';
import { HintParagraphs, HintSheet, ToggleWithHint, useHint } from '@/features/settings-b/ui';
import { useSettings } from '@/runtime/settings-store';
import { Row, Section, T, TrioScreen, useTrioColors } from '@/trio';

/** Trio Modules/HealthKit (AppleHealthKit.RootView); on Android the same screen drives Health Connect. */
export default function HealthScreen() {
  const c = useTrioColors();
  const help = useHint();
  const enabled = useSettings((s) => s.useHealth);
  const update = useSettings((s) => s.update);
  const [needsPermission, setNeedsPermission] = useState(false);
  const [error, setError] = useState('');
  const label = healthLabel();
  const android = Platform.OS === 'android';

  useEffect(() => {
    if (!enabled) return setNeedsPermission(false);
    void healthGlucoseWritable().then((ok) => setNeedsPermission(!ok));
  }, [enabled]);

  const toggle = async (value: boolean) => {
    update({ useHealth: value });
    setError('');
    if (!value) return setNeedsPermission(false);
    const r = await requestHealthPermission();
    if (r.error) setError(r.error);
    setNeedsPermission(!r.glucoseWritable);
  };

  return (
    <TrioScreen back title={android ? 'Health Connect' : 'Apple Health'}>
      <Section header={`${label} Integration`} footer={error || undefined}>
        <ToggleWithHint
          label={`Connect to ${label}`}
          value={enabled}
          onChange={(v) => void toggle(v)}
          miniHint={`Allow Buddy to write to ${label}.`}
          onHelp={() =>
            help.show({
              label: `Connect to ${label}`,
              body: (
                <HintParagraphs
                  boldFirst
                  lines={[
                    'Default: OFF',
                    android
                      ? 'This allows Buddy to write glucose readings and carbs to Health Connect. Health Connect has no insulin record, so insulin is not written.'
                      : 'This allows Buddy to write glucose readings, carbs and insulin to Apple Health. Deleting a record in Buddy deletes it there too.',
                    `Warning: You must also give permissions in ${android ? 'Health Connect' : 'iOS System Settings for the Health app'}.`,
                  ]}
                />
              ),
            })
          }
        />
      </Section>

      {enabled && needsPermission ? (
        <Section header="Give Write Permissions">
          <Row>
            <T color={c.secondary} style_="footnote" style={{ flex: 1 }}>
              {android
                ? 'Open Health Connect, choose "App permissions", select Buddy and allow writing blood glucose and nutrition.'
                : '1. Open the Settings app. 2. Choose Health, then Data Access & Devices. 3. Select Buddy. 4. Turn on Write Data for blood glucose, carbohydrates and insulin delivery.'}
            </T>
          </Row>
          <Row onPress={() => void Linking.openSettings()}>
            <T color={c.tabBar}>Open Settings</T>
          </Row>
        </Section>
      ) : null}
      <HintSheet hint={help.hint} onClose={help.close} />
    </TrioScreen>
  );
}
