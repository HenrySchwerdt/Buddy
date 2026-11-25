import { Linking } from 'react-native';
import { LinkButton, Row, Section, T } from '@/trio';
import { NOT_USED_NOTE, usePrefBoolean } from '@/features/settings/bindings';
import { SettingInputSection } from '@/features/settings/components/setting-input-section';
import { SettingsScreen } from '@/features/settings/components/settings-screen';
import { TRIO_COPY } from '@/features/settings/trio-copy';

/** Port of ShortcutsConfig.RootView. Buddy has no App Intents yet. */
export default function ShortcutsSettings() {
  return (
    <SettingsScreen title="Shortcuts">
      <Section header="Shortcuts Integration">
        <Row>
          <T>Buddy lets you create automations using iOS Shortcuts. Go to the Shortcuts app to create new automations.</T>
        </Row>
      </Section>
      <Section>
        <Row style={{ justifyContent: 'center' }}>
          <LinkButton label="Open iOS Shortcuts" onPress={() => void Linking.openURL('shortcuts://')} />
        </Row>
      </Section>
      <SettingInputSection copy={TRIO_COPY.allowBolusByShortcuts} boolean={usePrefBoolean('allowBolusByShortcuts')} note={NOT_USED_NOTE} />
    </SettingsScreen>
  );
}
