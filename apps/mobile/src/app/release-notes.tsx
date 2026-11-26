import Constants from 'expo-constants';
import { View } from 'react-native';
import { formatReleaseDate, notesFor, previousReleases, RELEASE_NOTES, type ReleaseNotes } from '@/features/about/release-notes';
import { Row, Section, T, TrioScreen } from '@/trio';

function Release({ release, current }: { release: ReleaseNotes; current: boolean }) {
  return (
    <Section header={`${release.version}${current ? ' (current release)' : ''}`} footer={formatReleaseDate(release.date)}>
      {release.highlights.map((h) => (
        <Row key={h}>
          <View style={{ flex: 1 }}>
            <T>{h}</T>
          </View>
        </Row>
      ))}
    </Section>
  );
}

/** Trio's ReleaseNotesDetailView / ReleaseNotesListView: the running release first, then earlier ones. */
export default function ReleaseNotesScreen() {
  const version = Constants.expoConfig?.version ?? RELEASE_NOTES[0]!.version;
  const current = notesFor(version);
  return (
    <TrioScreen back title="Release Notes">
      {current ? <Release release={current} current /> : null}
      {previousReleases(version).map((r) => (
        <Release key={r.version} release={r} current={false} />
      ))}
    </TrioScreen>
  );
}
