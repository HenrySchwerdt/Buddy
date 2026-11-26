import { HintParagraphs, HintSheet, ToggleWithHint, useHint } from '@/features/settings-b/ui';
import { useUploadStatus } from '@/runtime/services';
import { useSettings } from '@/runtime/settings-store';
import { Section, TrioScreen, useTrioColors, ValueRow } from '@/trio';

/** Trio NightscoutUploadView. */
export default function NightscoutUploadScreen() {
  const c = useTrioColors();
  const upload = useSettings((s) => s.nightscoutUpload);
  const uploadSensors = useSettings((s) => s.nightscoutUploadSensors);
  const url = useSettings((s) => s.nightscoutUrl);
  const update = useSettings((s) => s.update);
  const status = useUploadStatus();
  const help = useHint();
  const isConnected = url.length > 0;

  const statusText = !upload ? 'Off' : status.lastError ? 'Failed' : status.lastOk ? new Date(status.lastOk).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'Waiting';

  return (
    <TrioScreen back title="Upload">
      <Section>
        <ToggleWithHint
          label="Allow Uploading to Nightscout"
          value={upload}
          disabled={!isConnected}
          onChange={(v) => update({ nightscoutUpload: v })}
          miniHint={isConnected ? 'Enable uploading of selected data sets to Nightscout.' : 'Connect to Nightscout first to enable uploading.'}
          onHelp={() =>
            help.show({
              label: 'Allow Uploading to Nightscout',
              body: (
                <HintParagraphs
                  boldFirst
                  lines={[
                    'Default: OFF',
                    'The Upload Treatments toggle enables uploading of the following data sets to your connected Nightscout URL:',
                    '• Glucose\n• Boluses and Temp Basals\n• Carbs\n• Temp Targets\n• Overrides\n• Device Status (with phone battery)\n• Therapy profile and override presets',
                  ]}
                />
              ),
            })
          }
        />
      </Section>

      <Section>
        <ToggleWithHint
          label="Upload Glucose"
          value={upload}
          disabled
          onChange={() => {}}
          miniHint="Enable uploading of CGM readings to Nightscout. Included whenever uploading is allowed."
          onHelp={() =>
            help.show({ label: 'Upload Glucose', body: <HintParagraphs boldFirst lines={['Default: ON', 'Enabling this setting allows CGM readings from Buddy to be used in Nightscout.']} /> })
          }
        />
      </Section>

      <Section>
        <ToggleWithHint
          label="Upload CGM Sensor States"
          value={uploadSensors}
          disabled={!upload}
          onChange={(v) => update({ nightscoutUploadSensors: v })}
          miniHint="Enable uploading of CGM sensor starts to Nightscout as notes."
          onHelp={() =>
            help.show({
              label: 'Upload CGM Sensor States',
              body: (
                <HintParagraphs
                  boldFirst
                  lines={[
                    'Default: OFF',
                    'When your CGM starts a new sensor session, the start is uploaded to Nightscout as a "Sensor Start" note with the transmitter or sensor name.',
                    'Only CGMs that report their session start support this.',
                  ]}
                />
              ),
            })
          }
        />
      </Section>

      <Section header="Upload Status" footer={upload && status.lastError ? status.lastError : undefined}>
        <ValueRow label="Last Upload" value={statusText} valueColor={upload && status.lastError ? c.red : undefined} />
      </Section>

      <HintSheet hint={help.hint} onClose={help.close} />
    </TrioScreen>
  );
}
