import { SymbolView } from 'expo-symbols';
import { View } from 'react-native';
import { Row, Section, T, useTrioColors } from '@/trio';
import { SettingsScreen } from '@/features/settings/components/settings-screen';

/** Port of AppDiagnostics.RootView. Buddy collects nothing, so "Share Nothing" is the only option. */
export default function AppDiagnostics() {
  const c = useTrioColors();
  return (
    <SettingsScreen title="App Diagnostics">
      <Section header="Anonymized Data Sharing">
        <Row accessibilityLabel="Share Nothing, selected">
          <SymbolView name="largecircle.fill.circle" size={22} tintColor={c.accent} />
          <View style={{ flex: 1, gap: 4 }}>
            <T weight="700">Share Nothing</T>
            <T style_="footnote" secondary>
              Buddy sends no crash reports and no usage statistics.
            </T>
          </View>
        </Row>
      </Section>
      <Section>
        <Row>
          <T secondary>Buddy has no telemetry. Nothing about your device, your therapy settings or your health data leaves the phone except what you configure yourself (for example a Nightscout upload).</T>
        </Row>
      </Section>
    </SettingsScreen>
  );
}
