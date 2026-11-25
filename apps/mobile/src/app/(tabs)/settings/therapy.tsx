import { NavRow, Section } from '@/trio';
import { SettingsScreen, go } from '@/features/settings/components/settings-screen';

/** Port of TherapySettingsView. */
export default function TherapySettings() {
  return (
    <SettingsScreen title="Therapy Settings">
      <Section header="Basic Settings">
        <NavRow label="Units and Limits" onPress={() => go('/settings/units-limits')} />
      </Section>
      <Section header="Profiles">
        <NavRow label="Therapy Profiles" onPress={() => go('/settings/therapy-profiles')} />
      </Section>
      <Section header="Basic Insulin Rates & Targets">
        <NavRow label="Glucose Targets" onPress={() => go('/settings/therapy-targets')} />
        <NavRow label="Basal Rates" onPress={() => go('/settings/therapy-basal')} />
        <NavRow label="Carb Ratios" onPress={() => go('/settings/therapy-carb-ratios')} />
        <NavRow label="Insulin Sensitivities" onPress={() => go('/settings/therapy-isf')} />
      </Section>
    </SettingsScreen>
  );
}
