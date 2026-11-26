import * as Haptics from 'expo-haptics';
import { getAppIconName, setAlternateAppIcon, supportsAlternateIcons } from 'expo-alternate-app-icons';
import { useState } from 'react';
import { Alert, Image, StyleSheet } from 'react-native';
import { APP_ICONS, selectedIcon, type AppIconOption } from '@/features/app-icons/catalog';
import { SettingsScreen } from '@/features/settings/components/settings-screen';
import { Row, Section, T, useTrioColors } from '@/trio';
import { SymbolView } from '@/trio/symbol';

/** Port of IconConfig.RootView: pick one of Buddy's app icons. */
export default function AppIcons() {
  const c = useTrioColors();
  const [active, setActive] = useState<AppIconOption>(() => selectedIcon(supportsAlternateIcons ? getAppIconName() : null));

  const choose = async (icon: AppIconOption) => {
    if (icon.name === active.name) return;
    void Haptics.selectionAsync();
    try {
      await setAlternateAppIcon(icon.name);
      setActive(icon);
    } catch (e) {
      Alert.alert('Could Not Change Icon', e instanceof Error ? e.message : String(e), [{ text: 'OK', style: 'cancel' }]);
    }
  };

  return (
    <SettingsScreen title="App Icons">
      <Section footer={supportsAlternateIcons ? undefined : 'This device does not support alternate app icons.'}>
        {APP_ICONS.map((icon) => (
          <Row key={icon.label} onPress={supportsAlternateIcons ? () => void choose(icon) : undefined} accessibilityLabel={`${icon.label}${icon.name === active.name ? ', selected' : ''}`}>
            <Image source={icon.preview} style={styles.icon} accessibilityIgnoresInvertColors />
            <T style={{ flex: 1 }}>{icon.label}</T>
            {icon.name === active.name ? <SymbolView name="checkmark" size={18} tintColor={c.accent} weight="semibold" /> : null}
          </Row>
        ))}
      </Section>
    </SettingsScreen>
  );
}

const styles = StyleSheet.create({
  icon: { width: 50, height: 50, borderRadius: 10 },
});
