import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { go, SettingsScreen } from '@/features/settings/components/settings-screen';
import { installLogCapture } from '@/features/about/log-buffer';
import { notesFor } from '@/features/about/release-notes';
import { algorithms, cgms, pumps } from '@/runtime/runtime';
import { NavRow, Row, Section, T, ValueRow } from '@/trio';

installLogCapture();

/** Destination of the version card (Trio: SubmodulesView with build details). */
export default function About() {
  const version = Constants.expoConfig?.version ?? '0.1.0';
  const build = Constants.expoConfig?.ios?.buildNumber ?? String(Constants.expoConfig?.android?.versionCode ?? 1);
  const bundleId = Constants.expoConfig?.ios?.bundleIdentifier ?? Constants.expoConfig?.android?.package ?? 'dev.buddy.app';
  const engine = (globalThis as { HermesInternal?: unknown }).HermesInternal ? 'Hermes' : 'JavaScriptCore';
  const rn = Platform.constants.reactNativeVersion;
  return (
    <SettingsScreen title="Buddy">
      <Section header="Build">
        <ValueRow label="Version" value={version} />
        <ValueRow label="Build" value={build} />
        <ValueRow label="Bundle ID" value={bundleId} />
        <ValueRow label="Platform" value={`${Platform.OS} ${Platform.Version}`} />
        <ValueRow label="Expo SDK" value={Constants.expoConfig?.sdkVersion ?? 'unknown'} />
        <ValueRow label="React Native" value={`${rn.major}.${rn.minor}.${rn.patch}`} />
        <ValueRow label="JS Engine" value={engine} />
      </Section>
      <Section header="Algorithms">
        {algorithms.list().map((a) => (
          <ValueRow key={a.meta.id} label={a.meta.name} value={a.meta.version} />
        ))}
      </Section>
      <Section header="Devices">
        <ValueRow label="Pump drivers" value={String(pumps.list().length)} />
        <ValueRow label="CGM sources" value={String(cgms.list().length)} />
      </Section>
      <Section header="Support">
        <NavRow label="Report a Problem" onPress={() => go('/report-problem')} />
        <NavRow label="Release Notes" subtitle={notesFor(version) ? undefined : 'No notes for this build'} onPress={() => go('/release-notes')} />
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
