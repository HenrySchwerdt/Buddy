import Constants from 'expo-constants';
import { Row, Section, T, ValueRow } from '@/trio';
import { algorithms, cgms, pumps } from '@/runtime/runtime';
import { SettingsScreen } from '@/features/settings/components/settings-screen';

/** Destination of the version card (Trio: SubmodulesView with build details). */
export default function About() {
  return (
    <SettingsScreen title="Buddy">
      <Section header="Build">
        <ValueRow label="Version" value={Constants.expoConfig?.version ?? '0.1.0'} />
        <ValueRow label="Algorithms" value={String(algorithms.list().length)} />
        <ValueRow label="Pump drivers" value={String(pumps.list().length)} />
        <ValueRow label="CGM sources" value={String(cgms.list().length)} />
      </Section>
      <Section header="Not a medical device">
        <Row>
          <T secondary>
            Buddy is experimental open-source research software for studying automated insulin delivery algorithms. It is not approved by any regulator, it is not intended to diagnose or treat any
            condition, and it must not be used to make treatment decisions. Anyone who builds or runs it does so entirely at their own risk.
          </T>
        </Row>
      </Section>
      <Section header="Credits">
        <Row>
          <T secondary>
            Inspired by Trio (nightscout/Trio). The oref SMB algorithm is the OpenAPS oref0 determine-basal as shipped in Trio, MIT licensed, © the OpenAPS and Trio contributors. Virtual patients use
            the Hovorka 2004 model with parameters from Wilinska 2010.
          </T>
        </Row>
      </Section>
    </SettingsScreen>
  );
}
