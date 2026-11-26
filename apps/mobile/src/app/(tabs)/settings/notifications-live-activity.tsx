import { Linking, Platform } from 'react-native';
import { BorderedButton, ButtonCard } from '@/features/settings-b/ui';
import { HintedSection } from '@/features/settings/components/setting-input-section';
import { SettingsScreen } from '@/features/settings/components/settings-screen';
import { useNativeServices } from '@/runtime/background';
import { restartLiveActivityNow } from '@/runtime/background';
import { liveActivitiesAllowed, liveActivityAvailable, useLiveActivityState, type LiveActivityState } from '@/runtime/live-activity';
import type { LiveActivityFontSize, LockScreenView } from '@/runtime/live-activity-content';
import { useLiveActivitySettings } from '@/runtime/live-activity-settings';
import { PickerRow, Row, Section, T, ToggleRow } from '@/trio';

const VIEWS: readonly { value: LockScreenView; label: string }[] = [
  { value: 'simple', label: 'Simple' },
  { value: 'detailed', label: 'Detailed' },
];
const FONT_SIZES: readonly { value: LiveActivityFontSize; label: string }[] = [
  { value: 'small', label: 'Small' },
  { value: 'standard', label: 'Standard' },
  { value: 'large', label: 'Large' },
];

const STATE_TEXT: Readonly<Record<LiveActivityState, string>> = {
  unavailable: 'Not available in this build',
  off: 'Off',
  active: 'Running',
  denied: 'Live Activities are switched off in iOS Settings',
  waiting: 'Starts when Buddy is opened',
  error: 'Could not start. Open Buddy and try Restart.',
};

function LiveActivityIos() {
  const s = useLiveActivitySettings();
  const state = useLiveActivityState((x) => x.state);
  const allowed = liveActivitiesAllowed();
  return (
    <>
      {!allowed ? (
        <Section header="Display Live Data From Buddy">
          <Row>
            <T>Live Activities must be enabled under iOS Settings to allow Buddy to display live data.</T>
          </Row>
          <Row onPress={() => void Linking.openSettings()}>
            <T>Open iOS Settings</T>
          </Row>
        </Section>
      ) : (
        <HintedSection
          header="Display Live Data From Buddy"
          miniHint="Display customizable data on Lock Screen and Dynamic Island."
          hint={{
            label: 'Enable Live Activity',
            lines: [
              '**Default: OFF',
              'With Live Activities enabled, Buddy displays your choice of the following current data on your iPhone\'s Lock Screen and in the Dynamic Island:',
              '• Current Glucose Reading, trend arrow and delta',
              '• IOB: Insulin On Board',
              '• COB: Carbohydrates On Board',
              '• Last Updated: Time of Last Loop Cycle',
              '• Glucose Trend Chart',
              'iOS ends a Live Activity after 8 hours. Buddy starts a new one when you open the app, or use the Restart button below.',
            ],
          }}>
          <ToggleRow label="Enable Live Activity" value={s.enabled} onChange={(enabled) => s.update({ enabled })} />
        </HintedSection>
      )}
      {allowed && s.enabled ? (
        <>
          <HintedSection
            miniHint="Select simple or detailed style. See hint for more details."
            hint={{
              label: 'Lock Screen Widget Style',
              lines: [
                '**Default: Simple',
                '**Simple:',
                "Buddy's Simple Lock Screen Widget displays current glucose reading, trend arrow, delta and the timestamp of the current reading. You can set the size of the glucose reading.",
                '**Detailed:',
                'The Detailed Lock Screen Widget offers a glucose chart and lets you choose which of these to show: IOB, COB and the time of the last loop cycle.',
              ],
            }}>
            <PickerRow label="Lock Screen Widget Style" value={s.lockScreenView} options={VIEWS} onChange={(lockScreenView) => s.update({ lockScreenView })} />
          </HintedSection>
          {s.lockScreenView === 'simple' ? (
            <Section header="Widget Configuration">
              <PickerRow label="Glucose Font Size" value={s.simpleFontSize} options={FONT_SIZES} onChange={(simpleFontSize) => s.update({ simpleFontSize })} />
            </Section>
          ) : (
            <Section header="Widget Configuration">
              <ToggleRow label="IOB" value={s.showIob} onChange={(showIob) => s.update({ showIob })} />
              <ToggleRow label="COB" value={s.showCob} onChange={(showCob) => s.update({ showCob })} />
              <ToggleRow label="Last Updated" value={s.showUpdated} onChange={(showUpdated) => s.update({ showUpdated })} />
              <ToggleRow label="Glucose Chart" value={s.showChart} onChange={(showChart) => s.update({ showChart })} />
            </Section>
          )}
          <Section>
            <Row>
              <T style={{ flex: 1 }}>Status</T>
              <T secondary>{STATE_TEXT[state]}</T>
            </Row>
          </Section>
          <Section>
            <ButtonCard>
              <BorderedButton label="Restart Live Activity" icon="arrow.clockwise.circle" onPress={() => void restartLiveActivityNow()} />
            </ButtonCard>
          </Section>
        </>
      ) : null}
    </>
  );
}

function BackgroundAndroid() {
  const keepAlive = useLiveActivitySettings((s) => s.androidForegroundService);
  const update = useLiveActivitySettings((s) => s.update);
  const service = useNativeServices((s) => s.androidService);
  const error = useNativeServices((s) => s.androidError);
  return (
    <>
      <HintedSection
        header="Background Service"
        miniHint="Keeps Buddy looping with the screen off and shows glucose, IOB and COB in a notification."
        hint={{
          label: 'Background Service',
          lines: [
            '**Default: ON',
            'While a real pump or CGM is configured, Buddy runs a foreground service with an ongoing notification. It shows glucose, trend, delta, IOB, COB and the time of the last loop cycle, and it keeps the loop and the Bluetooth connection running in the background.',
            'Without it Android stops Buddy a short time after you leave the app. The service is not started for the simulator, and it uses some battery. Android may still stop it in battery saver mode or when you swipe the app away on some phones: allow Buddy to run unrestricted in Android battery settings.',
          ],
        }}>
        <ToggleRow label="Keep Buddy Running" value={keepAlive} onChange={(androidForegroundService) => update({ androidForegroundService })} />
      </HintedSection>
      <Section>
        <Row>
          <T style={{ flex: 1 }}>Status</T>
          <T secondary>{service === 'running' ? 'Running' : service === 'error' ? 'Could not start' : 'Off'}</T>
        </Row>
        {error ? (
          <Row>
            <T style_="footnote" secondary>
              {error}
            </T>
          </Row>
        ) : null}
      </Section>
    </>
  );
}

/** Trio Settings → Notifications → Live Activity (LiveActivitySettings.RootView); on Android the ongoing notification is the equivalent. */
export default function LiveActivitySettingsScreen() {
  const task = useNativeServices((s) => s.backgroundTask);
  return (
    <SettingsScreen title={Platform.OS === 'android' ? 'Background Service' : 'Live Activity'}>
      {Platform.OS === 'ios' ? (liveActivityAvailable() ? <LiveActivityIos /> : <UnavailableNote />) : null}
      {Platform.OS === 'android' ? <BackgroundAndroid /> : null}
      <Section header="Background Refresh" footer="The system decides when background refresh runs: usually not more often than every 15 minutes, and not in battery saver. It is a safety net, not a 5-minute scheduler.">
        <Row>
          <T style={{ flex: 1 }}>Periodic Background Task</T>
          <T secondary>{task === 'registered' ? 'Registered' : task === 'unregistered' ? 'Off' : 'Not available'}</T>
        </Row>
      </Section>
    </SettingsScreen>
  );
}

function UnavailableNote() {
  return (
    <Section header="Display Live Data From Buddy">
      <Row>
        <T>Live Activities are not part of this build of Buddy (needs the iOS app with the Live Activity extension).</T>
      </Row>
    </Section>
  );
}
