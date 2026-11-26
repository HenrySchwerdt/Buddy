import { HintParagraphs, HintSheet, ToggleWithHint, useHint } from '@/features/settings-b/ui';
import { useSettings } from '@/runtime/settings-store';
import { Section, TrioScreen } from '@/trio';

/** Trio NightscoutFetchView: fetch carbs and temp targets entered in Nightscout (about once a minute). */
export default function NightscoutFetchScreen() {
  const help = useHint();
  const download = useSettings((s) => s.nightscoutDownload);
  const connected = useSettings((s) => s.nightscoutUrl.length > 0);
  const update = useSettings((s) => s.update);
  return (
    <TrioScreen back title="Fetch">
      <Section header="Fetch NS Care Portal Data">
        <ToggleWithHint
          label="Allow Fetching from Nightscout"
          value={download && connected}
          disabled={!connected}
          onChange={(v) => update({ nightscoutDownload: v })}
          miniHint={connected ? 'Enable fetching of selected data sets from Nightscout.' : 'Connect to Nightscout first to enable fetching.'}
          onHelp={() =>
            help.show({
              label: 'Allow Fetching from Nightscout',
              body: (
                <HintParagraphs
                  boldFirst
                  lines={[
                    'Default: OFF',
                    'The Fetch Treatments toggle enables fetching of carbs and temp targets entered in Careportal or by another uploading device than Buddy from Nightscout.',
                    'Buddy looks for new entries about once a minute while it is open. A running temp target from Nightscout becomes active, and a cancel in Nightscout ends it.',
                  ]}
                />
              ),
            })
          }
        />
      </Section>
      <HintSheet hint={help.hint} onClose={help.close} />
    </TrioScreen>
  );
}
