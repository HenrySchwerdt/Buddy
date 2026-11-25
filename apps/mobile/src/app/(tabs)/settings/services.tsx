import { router } from 'expo-router';
import { Platform } from 'react-native';
import { UnavailableRow } from '@/features/settings-b/ui';
import { NavRow, Section, TrioScreen } from '@/trio';

/** Trio Settings → Services (ServicesView). Services Buddy lacks stay listed, disabled. */
export default function ServicesScreen() {
  return (
    <TrioScreen back title="Services">
      <Section header="Connected Services">
        <NavRow label="Nightscout" onPress={() => router.push('/settings/nightscout')} />
        <UnavailableRow label="Tidepool" />
        <UnavailableRow label={Platform.OS === 'android' ? 'Health Connect' : 'Apple Health'} />
      </Section>
    </TrioScreen>
  );
}
