import { SymbolView } from '@/trio/symbol';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Linking, StyleSheet, TextInput, View } from 'react-native';
import { checkConnection, errorMessage, loadToken, normalizeNightscoutUrl, saveToken } from '@/features/settings-b/nightscout';
import { BorderedButton } from '@/features/settings-b/ui';
import { useSettings } from '@/runtime/settings-store';
import { Row, Section, T, TrioScreen, useTrioColors } from '@/trio';

/** Trio NightscoutConnectView. */
export default function NightscoutConnectScreen() {
  const c = useTrioColors();
  const savedUrl = useSettings((s) => s.nightscoutUrl);
  const update = useSettings((s) => s.update);
  const [url, setUrl] = useState(savedUrl);
  const [token, setToken] = useState('');
  const [message, setMessage] = useState('');
  const [invalidUrl, setInvalidUrl] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const isConnected = savedUrl.length > 0;

  useEffect(() => {
    loadToken()
      .then(setToken)
      .catch((e: unknown) => setMessage(`Error: ${errorMessage(e)}`));
  }, []);

  const connect = async () => {
    const checked = normalizeNightscoutUrl(url);
    if (!checked.ok) {
      setMessage(checked.message);
      setInvalidUrl(true);
      return;
    }
    setUrl(checked.url);
    setInvalidUrl(false);
    setMessage('');
    setConnecting(true);
    try {
      await checkConnection(checked.url, token.trim());
      await saveToken(token.trim());
      update({ nightscoutUrl: checked.url });
      setMessage('Connected!');
    } catch (e) {
      setMessage(`Error: ${errorMessage(e)}`);
    } finally {
      setConnecting(false);
    }
  };

  const remove = async () => {
    try {
      await saveToken('');
    } catch (e) {
      setMessage(`Error: ${errorMessage(e)}`);
      return;
    }
    update({ nightscoutUrl: '', nightscoutUpload: false, nightscoutDownload: false, nightscoutUploadSensors: false, nightscoutState: {}, nightscoutDownloadState: {} });
    setUrl('');
    setToken('');
    setMessage('');
  };

  const openSite = () => {
    Linking.openURL(savedUrl).catch((e: unknown) => Alert.alert('Could not open Nightscout', errorMessage(e)));
  };

  return (
    <TrioScreen back title="Connect">
      <Section header="Connect to Nightscout">
        <Row>
          <TextInput
            value={url}
            onChangeText={setUrl}
            placeholder="URL"
            placeholderTextColor={c.tertiary}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            textContentType="URL"
            editable={!isConnected}
            selectionColor={c.tabBar}
            style={[styles.input, { color: c.primary }]}
            accessibilityLabel="URL"
          />
          {message && invalidUrl ? <SymbolView name="exclamationmark.triangle.fill" size={18} tintColor={c.orange} /> : null}
        </Row>
        <Row>
          <TextInput
            value={token}
            onChangeText={setToken}
            placeholder="Access token"
            placeholderTextColor={c.tertiary}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="ascii-capable"
            textContentType="password"
            editable={!isConnected}
            selectionColor={c.tabBar}
            style={[styles.input, { color: c.primary }]}
            accessibilityLabel="Access token"
          />
        </Row>
        {message ? (
          <Row>
            <T>{message}</T>
          </Row>
        ) : null}
        {connecting ? (
          <Row>
            <T style={{ flex: 1 }}>Connecting...</T>
            <ActivityIndicator />
          </Row>
        ) : null}
        <View style={styles.buttonRow}>
          {!isConnected ? (
            <BorderedButton label="Connect to Nightscout" onPress={() => void connect()} disabled={url.trim().length === 0 || connecting} />
          ) : (
            <BorderedButton label="Disconnect and Remove" color={c.loopRed} onPress={() => void remove()} />
          )}
        </View>
      </Section>

      {isConnected ? (
        <View style={{ paddingVertical: 8 }}>
          <BorderedButton label="Open Nightscout" icon="waveform.path.ecg.rectangle" onPress={openSite} />
        </View>
      ) : null}
    </TrioScreen>
  );
}

const styles = StyleSheet.create({
  input: { flex: 1, fontSize: 17, paddingVertical: 0 },
  buttonRow: { paddingHorizontal: 20, paddingVertical: 12 },
});
