import { router, useLocalSearchParams } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { Alert, Pressable, StyleSheet, View } from 'react-native';
import { Section, T, TrioScreen, useTrioColors } from '@/trio';
import { catalogFor, isSupported, modelsLine, type DeviceKind } from '@/features/devices/catalog';
import { useActiveDevice } from '@/features/devices/device-actions';
import { DeviceIcon } from '@/features/devices/device-icon';

const HINTS: Record<DeviceKind, { title: string; intro: string; note: string }> = {
  pump: {
    title: 'Pump Pairing to Buddy',
    intro: 'Current Pump Models Supported:',
    note: 'Note: If using a pump simulator, you will not have continuous readings from the CGM in Buddy. Using a pump simulator is only advisable for becoming familiar with the app user interface. It will not give you insight on how the algorithm will respond.',
  },
  cgm: {
    title: 'Help',
    intro: 'Current CGM Models Supported:',
    note: 'Note: Buddy reads glucose on a timer. A CGM does not act as a heartbeat that wakes Buddy in the background.',
  },
};

function showHint(kind: DeviceKind) {
  const h = HINTS[kind];
  const lines = catalogFor(kind)
    .filter((e) => isSupported(e) && (__DEV__ || e.manufacturer !== 'Simulator'))
    .map((e) => `• ${e.name}${modelsLine(e) ? ` (${modelsLine(e)})` : ''}`);
  Alert.alert(h.title, [h.intro, ...lines, '', h.note].join('\n'));
}

/**
 * Settings → Devices → Insulin Pump / Continuous Glucose Monitor
 * (Trio `PumpConfig.RootView` / `CGMSettings.RootView`).
 */
export default function DeviceConfig() {
  const c = useTrioColors();
  const { kind: raw } = useLocalSearchParams<{ kind?: string }>();
  const kind: DeviceKind = raw === 'cgm' ? 'cgm' : 'pump';
  const active = useActiveDevice(kind);
  const pump = kind === 'pump';
  return (
    <TrioScreen title={pump ? 'Insulin Pump' : 'CGM'} back>
      <Section header={pump ? 'Pump Integration to Buddy' : 'CGM Integration to Buddy'}>
        {active ? (
          <Pressable
            onPress={() => router.push(pump ? '/pump-settings' : '/cgm-settings')}
            accessibilityRole="button"
            style={({ pressed }) => [styles.current, { opacity: pressed ? 0.6 : 1 }]}>
            {pump ? (
              <DeviceIcon entry={active.entry} size={50} background="transparent" />
            ) : (
              <SymbolView name="sensor.tag.radiowaves.forward.fill" size={24} tintColor={c.accent} />
            )}
            <T style_="title2" weight="400" color={c.accent}>
              {active.entry.name}
            </T>
          </Pressable>
        ) : (
          <View style={styles.empty}>
            <Pressable
              onPress={() => router.push(pump ? '/add-pump' : '/add-cgm')}
              accessibilityRole="button"
              style={({ pressed }) => [styles.bordered, { backgroundColor: c.fill, opacity: pressed ? 0.6 : 1 }]}>
              <T style_="title3" weight="400" color={c.accent}>
                {pump ? 'Add Pump' : 'Add CGM'}
              </T>
            </Pressable>
            <View style={styles.hintRow}>
              <T style_="footnote" secondary style={{ flex: 1 }}>
                {pump ? 'Pair your insulin pump with Buddy. See hint for compatible devices.' : 'Pair your CGM with Buddy. See hint for compatible devices.'}
              </T>
              <Pressable onPress={() => showHint(kind)} accessibilityRole="button" accessibilityLabel="More information" hitSlop={8}>
                <SymbolView name="questionmark.circle" size={20} tintColor={c.accent} />
              </Pressable>
            </View>
          </View>
        )}
      </Section>
    </TrioScreen>
  );
}

const styles = StyleSheet.create({
  current: { minHeight: 50, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  empty: { paddingHorizontal: 20, paddingVertical: 20, gap: 16 },
  bordered: { height: 50, borderRadius: 25, alignItems: 'center', justifyContent: 'center', borderCurve: 'continuous' },
  hintRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
});
