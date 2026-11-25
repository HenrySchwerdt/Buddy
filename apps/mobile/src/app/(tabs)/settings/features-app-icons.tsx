import { Image, StyleSheet } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { Row, Section, T, useTrioColors } from '@/trio';
import { SettingsScreen } from '@/features/settings/components/settings-screen';

/** Port of IconConfig.RootView. Buddy ships one icon, so the list has a single selected entry. */
export default function AppIcons() {
  const c = useTrioColors();
  return (
    <SettingsScreen title="App Icons">
      <Section>
        <Row>
          <Image source={require('@/assets/images/icon.png')} style={styles.icon} />
          <T style={{ flex: 1 }}>Buddy</T>
          <SymbolView name="checkmark" size={18} tintColor={c.accent} weight="semibold" />
        </Row>
      </Section>
    </SettingsScreen>
  );
}

const styles = StyleSheet.create({
  icon: { width: 50, height: 50, borderRadius: 10 },
});
