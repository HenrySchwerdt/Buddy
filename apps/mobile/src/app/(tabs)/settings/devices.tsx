import { router } from 'expo-router';
import { View } from 'react-native';
import { NavRow, Row, Section, T, TrioScreen } from '@/trio';
import { NOT_SUPPORTED } from '@/features/devices/catalog';

/** Settings → Devices (Trio `DevicesView`). */
export default function Devices() {
  return (
    <TrioScreen title="Devices" back>
      <Section header="Setup & Configuration">
        <NavRow label="Insulin Pump" onPress={() => router.push({ pathname: '/settings/device', params: { kind: 'pump' } })} />
        <NavRow label="Continuous Glucose Monitor" onPress={() => router.push({ pathname: '/settings/device', params: { kind: 'cgm' } })} />
        <Row accessibilityLabel={`Smart Watch, ${NOT_SUPPORTED}`}>
          <View style={{ flex: 1, opacity: 0.45 }}>
            <T>Smart Watch</T>
            <T style_="footnote" secondary>
              {NOT_SUPPORTED}
            </T>
          </View>
        </Row>
      </Section>
    </TrioScreen>
  );
}
