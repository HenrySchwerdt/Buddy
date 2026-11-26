import { router, type Href } from 'expo-router';
import { Platform } from 'react-native';
import { NavRow, Section, TrioScreen } from '@/trio';

/** Trio Settings → Services (ServicesView). */
export default function ServicesScreen() {
  return (
    <TrioScreen back title="Services">
      <Section header="Connected Services">
        <NavRow label="Nightscout" onPress={() => router.push('/settings/nightscout')} />
        <NavRow label="Tidepool" onPress={() => router.push('/settings/services-tidepool' as Href)} />
        <NavRow label={Platform.OS === 'android' ? 'Health Connect' : 'Apple Health'} onPress={() => router.push('/settings/services-health' as Href)} />
      </Section>
    </TrioScreen>
  );
}
