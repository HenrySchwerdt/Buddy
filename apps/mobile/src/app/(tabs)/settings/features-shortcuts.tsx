import { Linking, Platform } from 'react-native';
import { LinkButton, Row, Section, T } from '@/trio';
import { usePrefBoolean } from '@/features/settings/bindings';
import { SettingInputSection } from '@/features/settings/components/setting-input-section';
import { SettingsScreen } from '@/features/settings/components/settings-screen';
import { TRIO_COPY } from '@/features/settings/trio-copy';
import { buildShortcutUrl } from '@/runtime/shortcuts-link';

const ANDROID = Platform.OS === 'android';

const LINKS: readonly { label: string; url: string }[] = [
  { label: 'Bolus 1.5 U', url: buildShortcutUrl({ kind: 'bolus', units: 1.5 }) },
  { label: 'Add 30 g carbs', url: buildShortcutUrl({ kind: 'carbs', grams: 30, fat: 0, protein: 0, note: '' }) },
  { label: 'Meal preset', url: buildShortcutUrl({ kind: 'carbPreset', name: 'Pizza' }) },
  { label: 'Start override', url: buildShortcutUrl({ kind: 'overrideApply', name: 'Exercise' }) },
  { label: 'Cancel override', url: buildShortcutUrl({ kind: 'overrideCancel' }) },
  { label: 'Start temp target', url: buildShortcutUrl({ kind: 'tempTargetApply', name: 'Eating Soon' }) },
  { label: 'Cancel temp target', url: buildShortcutUrl({ kind: 'tempTargetCancel' }) },
  { label: 'Current state', url: buildShortcutUrl({ kind: 'state' }) },
];

/** Port of ShortcutsConfig.RootView. iOS: App Intents in the Shortcuts app. Android: launcher shortcuts. Both: buddy:// links. */
export default function ShortcutsSettings() {
  return (
    <SettingsScreen title="Shortcuts">
      <Section header="Shortcuts Integration">
        <Row>
          <T>
            {ANDROID
              ? 'Long-press the Buddy icon for shortcuts to your override and temp target presets, or use the buddy:// links below from automation apps such as Tasker.'
              : 'Buddy lets you create automations using iOS Shortcuts. Go to the Shortcuts app to create new automations: Buddy offers Bolus, Add Carbs, Meal Presets, Overrides, Temp Targets, List State and Restart Live Activity.'}
          </T>
        </Row>
        <Row>
          <T>Every action opens Buddy and waits for your confirmation. Nothing is delivered or changed by a shortcut on its own.</T>
        </Row>
      </Section>
      {ANDROID ? null : (
        <Section>
          <Row style={{ justifyContent: 'center' }}>
            <LinkButton label="Open iOS Shortcuts" onPress={() => void Linking.openURL('shortcuts://')} />
          </Row>
        </Section>
      )}
      <SettingInputSection copy={TRIO_COPY.allowBolusByShortcuts} boolean={usePrefBoolean('allowBolusByShortcuts')} />
      <Section header="Links" footer="Preset names must match a saved preset (not case sensitive). Bolus links are refused unless bolusing with Shortcuts is on and the safety checks pass.">
        {LINKS.map((l) => (
          <Row key={l.label}>
            <T style={{ flex: 1 }}>{l.label}</T>
            <T style_="footnote" secondary selectable>
              {l.url}
            </T>
          </Row>
        ))}
      </Section>
    </SettingsScreen>
  );
}
