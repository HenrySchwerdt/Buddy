import { useState } from 'react';
import { ActivityIndicator, Alert, View } from 'react-native';
import { LinkButton, NavRow, Row, Section, T, useTrioColors } from '@/trio';
import { importNightscoutProfile } from '@/runtime/runtime';
import { HintButton } from '@/features/settings/components/setting-input-section';
import { useShowHint } from '@/features/settings/components/hint-sheet';
import { SettingsScreen, go } from '@/features/settings/components/settings-screen';
import { nameProblem, useProfileList, useProfiles } from '@/features/settings/profiles';

const PROFILES_HINT = {
  label: 'Therapy Profiles',
  lines: [
    'A profile holds basal rates, carb ratios, insulin sensitivities and glucose targets. Trio always uses the active profile, and editing the therapy settings edits the active profile.',
    "Activating a profile makes Trio use its basal rates, carb ratios, insulin sensitivities and glucose targets from the next loop cycle on.",
    'Overrides and temporary targets are not part of a profile. One that is running stays on and applies on top of the newly active profile.',
  ],
};

/** Port of TherapyProfiles.RootView (without scheduled switches) plus Buddy's Nightscout import. */
export default function TherapyProfiles() {
  return (
    <SettingsScreen title="Therapy Profiles">
      <ProfilesBody />
    </SettingsScreen>
  );
}

function ProfilesBody() {
  const c = useTrioColors();
  const list = useProfileList();
  const activeName = useProfiles((s) => s.activeName);
  const saveActiveAsNew = useProfiles((s) => s.saveActiveAsNew);
  const showHint = useShowHint();
  const [importing, setImporting] = useState(false);

  const promptNew = () =>
    Alert.prompt('New Profile', 'Enter a name for the new profile.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Save',
        onPress: (name?: string) => {
          const problem = nameProblem(name ?? '', list.map((p) => p.name));
          if (problem) return Alert.alert('Profile Not Changed', problem);
          saveActiveAsNew(name ?? '');
        },
      },
    ]);

  const doImport = () =>
    Alert.alert('Import from Nightscout?', `Replaces basal rates, insulin sensitivities, carb ratios, glucose targets and DIA of the active profile (${activeName}) with the active Nightscout profile.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Import',
        onPress: async () => {
          setImporting(true);
          try {
            await importNightscoutProfile();
          } catch (e) {
            Alert.alert('Import failed', e instanceof Error ? e.message : String(e));
          } finally {
            setImporting(false);
          }
        },
      },
    ]);

  return (
    <>
      <Section header="Profiles">
        {list.map((p) => (
          <NavRow key={p.name} label={p.name} value={p.name === activeName ? 'Active' : undefined} onPress={() => go('/settings/therapy-profile', { name: p.name })} />
        ))}
      </Section>
      <Section>
        <Row>
          <LinkButton label="Save Current Settings as New Profile" onPress={promptNew} />
        </Row>
        <Row>
          <T style_="footnote" secondary style={{ flex: 1 }}>
            Buddy always uses the active profile.
          </T>
          <HintButton label="Therapy Profiles" onPress={() => showHint(PROFILES_HINT)} />
        </Row>
      </Section>
      <Section header="Nightscout" footer="Imports the profile Trio (or another loop) uploads to your Nightscout site into the active profile.">
        <Row>
          {importing ? <ActivityIndicator color={c.tabBar} /> : <LinkButton label="Import from Nightscout" onPress={doImport} />}
          <View style={{ flex: 1 }} />
        </Row>
      </Section>
    </>
  );
}
