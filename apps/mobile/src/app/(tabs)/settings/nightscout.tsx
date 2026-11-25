import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { Alert, View } from 'react-native';
import { backfillGlucose, errorMessage, importProfileFromNightscout } from '@/features/settings-b/nightscout';
import { BorderedButton, HintSheet, MiniHint, useHint } from '@/features/settings-b/ui';
import { useUploadStatus } from '@/runtime/services';
import { useSettings } from '@/runtime/settings-store';
import { NavRow, Row, Section, T, TrioScreen, useTrioColors } from '@/trio';

/** Trio NightscoutConfig.RootView. */
export default function NightscoutScreen() {
  const c = useTrioColors();
  const url = useSettings((s) => s.nightscoutUrl);
  const upload = useSettings((s) => s.nightscoutUpload);
  const status = useUploadStatus();
  const help = useHint();
  const [backfilling, setBackfilling] = useState(false);
  const [importing, setImporting] = useState(false);
  const isConnected = url.length > 0;

  const backfill = async () => {
    setBackfilling(true);
    try {
      const n = await backfillGlucose();
      Alert.alert('Backfill Glucose', n ? `Backfilled ${n} glucose readings.` : 'No glucose to backfill.');
    } catch (e) {
      Alert.alert('Backfill Failed', `Error: ${errorMessage(e)}`, [{ text: 'OK' }]);
    } finally {
      setBackfilling(false);
    }
  };

  const runImport = async () => {
    setImporting(true);
    try {
      await importProfileFromNightscout();
      Alert.alert('Import Settings', 'Basal rates, ISF, carb ratios, targets and DIA were imported. Review them in Therapy settings.');
    } catch (e) {
      Alert.alert('Import Failed', `Error: ${errorMessage(e)}`, [{ text: 'OK' }]);
    } finally {
      setImporting(false);
    }
  };

  const confirmImport = () =>
    Alert.alert('Import Settings from Nightscout?', 'This replaces your basal rates, ISF, carb ratios, glucose targets and DIA with the active Nightscout profile.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Import', style: 'destructive', onPress: () => void runImport() },
    ]);

  const lastUpload = status.lastError
    ? { text: status.lastError, color: c.red }
    : status.lastOk
      ? { text: `Last upload ${new Date(status.lastOk).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`, color: c.secondary }
      : null;

  return (
    <TrioScreen back title="Nightscout">
      <Section header="Nightscout Integration">
        <Row onPress={() => router.push('/settings/nightscout-connect')} accessibilityLabel={`Connect, ${isConnected ? 'connected' : 'not connected'}`}>
          <T>Connect</T>
          <View style={{ width: 28, height: 24, justifyContent: 'center' }}>
            <SymbolView name={isConnected ? 'network' : 'network.slash'} size={20} tintColor={c.primary} />
            {isConnected ? (
              <View style={{ position: 'absolute', left: 13, top: 12 }}>
                <SymbolView name="checkmark.circle.fill" size={11} tintColor={c.green} />
              </View>
            ) : null}
          </View>
          <View style={{ flex: 1 }} />
          <SymbolView name="chevron.right" size={14} tintColor={c.tertiary} weight="semibold" />
        </Row>
        <NavRow label="Upload" value={upload ? 'On' : undefined} onPress={() => router.push('/settings/nightscout-upload')} />
        <NavRow label="Fetch" onPress={() => router.push('/settings/nightscout-fetch')} />
      </Section>
      {lastUpload && upload ? (
        <T style_="footnote" color={lastUpload.color} style={{ marginHorizontal: 20, marginTop: -8 }}>
          {lastUpload.text}
        </T>
      ) : null}

      <Section>
        <View style={{ paddingHorizontal: 20, paddingTop: 24 }}>
          <BorderedButton label="Backfill Glucose" onPress={() => void backfill()} loading={backfilling} disabled={!isConnected} />
          <MiniHint
            text="Backfill missing glucose data from Nightscout."
            label="Backfill Glucose"
            onHelp={() => help.show({ label: 'Backfill Glucose from Nightscout', body: 'This will backfill 24 hours of glucose data from your connected Nightscout URL to Buddy' })}
          />
        </View>
      </Section>

      <Section>
        <View style={{ paddingHorizontal: 20, paddingTop: 24 }}>
          <BorderedButton label="Import Settings" onPress={confirmImport} loading={importing} disabled={!isConnected} />
          <MiniHint
            text="Import therapy settings from your Nightscout profile."
            label="Import Settings"
            onHelp={() =>
              help.show({
                label: 'Import Settings from Nightscout',
                body: 'Replaces basal rates, insulin sensitivities, carb ratios, glucose targets and DIA with the default profile of your connected Nightscout site. Review the values in Therapy settings afterwards.',
              })
            }
          />
        </View>
      </Section>

      <HintSheet hint={help.hint} onClose={help.close} />
    </TrioScreen>
  );
}
