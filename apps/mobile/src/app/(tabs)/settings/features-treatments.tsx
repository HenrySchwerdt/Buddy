import { NavRow, Section } from '@/trio';
import { SettingsScreen, go } from '@/features/settings/components/settings-screen';

/** Port of TreatmentsSettingsView. */
export default function TreatmentsSettings() {
  return (
    <SettingsScreen title="Treatments">
      <Section>
        <NavRow label="Bolus Calculator" onPress={() => go('/settings/features-bolus-calculator')} />
        <NavRow label="Quick-Pick Treatments" onPress={() => go('/settings/features-quick-pick')} />
        <NavRow label="Meal Settings" onPress={() => go('/settings/features-meal')} />
      </Section>
    </SettingsScreen>
  );
}
