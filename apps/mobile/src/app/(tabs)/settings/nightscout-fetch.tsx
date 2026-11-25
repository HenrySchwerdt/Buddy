import { HintParagraphs, HintSheet, ToggleWithHint, useHint } from '@/features/settings-b/ui';
import { Section, TrioScreen } from '@/trio';

/** Trio NightscoutFetchView. Buddy does not fetch Careportal data yet, so the toggle is disabled. */
export default function NightscoutFetchScreen() {
  const help = useHint();
  return (
    <TrioScreen back title="Fetch">
      <Section header="Fetch NS Care Portal Data">
        <ToggleWithHint
          label="Allow Fetching from Nightscout"
          value={false}
          disabled
          onChange={() => {}}
          miniHint="Enable fetching of selected data sets from Nightscout. Not available yet."
          onHelp={() =>
            help.show({
              label: 'Allow Fetching from Nightscout',
              body: (
                <HintParagraphs
                  boldFirst
                  lines={[
                    'Default: OFF',
                    'The Fetch Treatments toggle enables fetching of carbs and temp targets entered in Careportal or by another uploading device than Buddy from Nightscout.',
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
