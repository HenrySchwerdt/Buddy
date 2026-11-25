import { NavRow, Section } from '@/trio';
import { SettingsScreen, go } from '@/features/settings/components/settings-screen';

/** Port of FeatureSettingsView. */
export default function FeatureSettings() {
  return (
    <SettingsScreen title="Feature Settings">
      <Section header="Buddy Features">
        <NavRow label="Treatments" onPress={() => go('/settings/features-treatments')} />
        <NavRow label="Shortcuts" onPress={() => go('/settings/features-shortcuts')} />
        <NavRow label="Remote Control" onPress={() => go('/settings/features-remote-control')} />
      </Section>
      <Section header="Buddy Personalization">
        <NavRow label="User Interface" onPress={() => go('/settings/features-user-interface')} />
        <NavRow label="App Icons" onPress={() => go('/settings/features-app-icons')} />
      </Section>
      <Section header="Anonymized Data Sharing">
        <NavRow label="App Diagnostics" onPress={() => go('/settings/features-app-diagnostics')} />
      </Section>
    </SettingsScreen>
  );
}
