import { router } from 'expo-router';
import { UnavailableRow } from '@/features/settings-b/ui';
import { NavRow, Section, TrioScreen } from '@/trio';

/** Trio Settings → Services (ServicesView). Services Buddy lacks stay listed, disabled. */
export default function ServicesScreen() {
  return (
    <TrioScreen back title="Services">
      <Section header="Connected Services">
        <NavRow label="Nightscout" onPress={() => router.push('/settings/nightscout')} />
        <UnavailableRow label="Tidepool" />
        <UnavailableRow label="Apple Health" />
      </Section>
    </TrioScreen>
  );
}
