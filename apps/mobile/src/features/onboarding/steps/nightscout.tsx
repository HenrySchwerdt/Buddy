import * as Haptics from 'expo-haptics';
import { SymbolView } from '@/trio/symbol';
import { useEffect } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { connectToNightscout, prefillNightscout } from '../nightscout';
import { useOnboardingDraft } from '../store';
import { OB, OT } from '../theme';
import { Bullet, Card, Footnote, Headline, RadioCard, Stack, ToggleCard } from '../ui';

export function NightscoutSetupStep() {
  const setup = useOnboardingDraft((s) => s.nightscout.setup);
  const setNightscout = useOnboardingDraft((s) => s.setNightscout);
  return (
    <Stack>
      <Headline>Nightscout use is entirely optional. You can also setup Nightscout at a later time.</Headline>
      <RadioCard label="Setup Nightscout for Buddy" selected={setup === 'setup'} onPress={() => setNightscout({ setup: 'setup' })} />
      <RadioCard label="Skip Nightscout Setup" selected={setup === 'skip'} onPress={() => setNightscout({ setup: 'skip' })} />
      <Footnote>You can use Nightscout to import your existing therapy settings, or if you prefer, you can only connect to Nightscout, and configure therapy settings from scratch.</Footnote>
      <Footnote>{`Other third-party services, like ${Platform.OS === 'android' ? 'Health Connect' : 'Apple Health'} or Tidepool, can be added later through the settings menu.`}</Footnote>
    </Stack>
  );
}

export function NightscoutLoginStep() {
  const ns = useOnboardingDraft((s) => s.nightscout);
  const setNightscout = useOnboardingDraft((s) => s.setNightscout);
  useEffect(() => {
    void prefillNightscout();
  }, []);
  const invalid = ns.responseMessage !== '' && !ns.connected;
  return (
    <Stack>
      <Headline>Please enter your credentials:</Headline>
      <Card style={styles.field}>
        <TextInput
          value={ns.url}
          onChangeText={(url) => setNightscout({ url, connected: false, responseMessage: '' })}
          placeholder="URL"
          placeholderTextColor={OB.tertiary}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          textContentType="URL"
          style={styles.input}
          accessibilityLabel="URL"
        />
        {invalid ? <SymbolView name="exclamationmark.triangle.fill" size={18} tintColor={OB.orange} /> : null}
      </Card>
      <Card style={styles.field}>
        <TextInput
          value={ns.token}
          onChangeText={(token) => setNightscout({ token, connected: false, responseMessage: '' })}
          placeholder="Access token"
          placeholderTextColor={OB.tertiary}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          textContentType="password"
          style={styles.input}
          accessibilityLabel="Access token"
        />
      </Card>
      <View style={{ height: 10 }} />
      <ConnectButton disabled={ns.connected || ns.url === '' || ns.token === ''} connecting={ns.connecting} />
      {ns.responseMessage !== '' ? (
        <OT style_="subheadline" color={OB.orange} align="center">
          {ns.responseMessage}
        </OT>
      ) : ns.connected ? (
        <View style={styles.connected}>
          <OT style_="subheadline" color={OB.green}>
            Connected
          </OT>
          <View>
            <SymbolView name="network" size={20} tintColor={OB.primary} />
            <SymbolView name="checkmark.circle.fill" size={11} tintColor={OB.green} style={styles.badge} />
          </View>
        </View>
      ) : null}
    </Stack>
  );
}

function ConnectButton({ disabled, connecting }: { disabled: boolean; connecting: boolean }) {
  return (
    <Pressable
      disabled={disabled || connecting}
      accessibilityRole="button"
      onPress={() => {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
        void connectToNightscout();
      }}
      style={({ pressed }) => [styles.connect, { backgroundColor: disabled ? OB.fill : OB.blue, opacity: pressed ? 0.8 : 1 }]}>
      {connecting ? <ActivityIndicator color={OB.onAccent} style={{ marginRight: 10 }} /> : null}
      <OT weight="700" color={disabled ? OB.secondary : OB.onAccent}>
        {connecting ? 'Connecting...' : 'Connect to Nightscout'}
      </OT>
    </Pressable>
  );
}

export function NightscoutUploadStep() {
  const ns = useOnboardingDraft((s) => s.nightscout);
  const setNightscout = useOnboardingDraft((s) => s.setNightscout);
  return (
    <Stack>
      <Headline>Please choose if you want to upload treatment data to Nightscout.</Headline>
      <ToggleCard label="Allow Uploading to Nightscout" value={ns.uploadEnabled} onChange={(uploadEnabled) => setNightscout({ uploadEnabled })} />
      <Footnote>The Upload Treatments toggle enables uploading of the following data sets to your connected Nightscout URL:</Footnote>
      <View style={[styles.inset, { gap: 5 }]}>
        {['Carbs', 'Temp Targets', 'Device Status', 'Preferences', 'Settings'].map((t) => (
          <OT key={t} style_="footnote" secondary>{`• ${t}`}</OT>
        ))}
      </View>
      <ToggleCard label="Upload CGM Sensor States" value={ns.uploadCGMSensorStates} onChange={(uploadCGMSensorStates) => setNightscout({ uploadCGMSensorStates })} disabled={!ns.uploadEnabled} />
      <Footnote>When your CGM reports a state where it cannot give a usable reading, such as a sensor error or warmup, Buddy uploads that state to Nightscout as a note. Supported for Dexcom G6 and G7.</Footnote>
    </Stack>
  );
}

export function NightscoutUploadGlucoseStep() {
  const uploadGlucose = useOnboardingDraft((s) => s.nightscout.uploadGlucose);
  const setNightscout = useOnboardingDraft((s) => s.setNightscout);
  return (
    <Stack>
      <Headline>Please choose if you want to upload CGM readings from Buddy to Nightscout.</Headline>
      <ToggleCard label="Upload Glucose" value={uploadGlucose} onChange={(v) => setNightscout({ uploadGlucose: v })} />
      <Footnote>Enabling this setting allows CGM readings from Buddy to be used in Nightscout.</Footnote>
    </Stack>
  );
}

export function NightscoutImportStep() {
  const ns = useOnboardingDraft((s) => s.nightscout);
  const setNightscout = useOnboardingDraft((s) => s.setNightscout);
  if (ns.importStatus === 'running') {
    return (
      <View style={styles.progress}>
        <OT weight="700" rounded>
          Importing Settings...
        </OT>
        <ActivityIndicator color={OB.tabBar} />
      </View>
    );
  }
  return (
    <Stack>
      <Headline>Please choose if you want to import existing therapy settings from Nightscout or start from scratch.</Headline>
      <RadioCard label="Import Settings" selected={ns.importOption === 'import'} onPress={() => setNightscout({ importOption: 'import' })} />
      <RadioCard label="Configure Yourself" selected={ns.importOption === 'skip'} onPress={() => setNightscout({ importOption: 'skip' })} />
      <View style={[styles.inset, { gap: 10 }]}>
        <OT style_="footnote" secondary>
          Buddy will import the following therapy settings from your Nightscout instance:
        </OT>
        <View>
          {['Glucose Targets', 'Basal Rates', 'Carb Ratios', 'Insulin Sensitivities'].map((t) => (
            <Bullet key={t} text={t} style_="footnote" secondary />
          ))}
        </View>
      </View>
    </Stack>
  );
}

const styles = StyleSheet.create({
  field: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  input: { flex: 1, color: OB.primary, fontSize: 17, paddingVertical: 0 },
  connect: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 14, borderRadius: 999 },
  connected: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  badge: { position: 'absolute', right: -6, bottom: -4 },
  inset: { paddingHorizontal: 16 },
  progress: { alignItems: 'center', gap: 16, paddingTop: 150 },
});
