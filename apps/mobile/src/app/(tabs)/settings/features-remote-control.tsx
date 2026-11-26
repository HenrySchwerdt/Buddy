import { useEffect, useState } from 'react';
import { Alert, StyleSheet, TextInput } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { BorderedButton, ButtonCard, HintParagraphs, HintSheet, ToggleWithHint, useHint } from '@/features/settings-b/ui';
import { generateSharedSecret, loadRemoteSecret, saveRemoteSecret } from '@/runtime/remote-control/wiring';
import { useSettings } from '@/runtime/settings-store';
import { Row, Section, T, TrioScreen, useTrioColors } from '@/trio';

/** Port of RemoteControlConfig: enable switch and the shared secret the follower app needs. */
export default function RemoteControlSettings() {
  const c = useTrioColors();
  const help = useHint();
  const enabled = useSettings((s) => s.remoteControlEnabled);
  const update = useSettings((s) => s.update);
  const [secret, setSecret] = useState('');
  const [loaded, setLoaded] = useState(false);

  // Trio creates a secret the first time the screen opens; it is kept in the keychain.
  useEffect(() => {
    void (async () => {
      let s = await loadRemoteSecret();
      if (!s) {
        s = generateSharedSecret();
        await saveRemoteSecret(s);
      }
      setSecret(s);
      setLoaded(true);
    })();
  }, []);

  const change = (value: string) => {
    setSecret(value);
    void saveRemoteSecret(value.trim());
  };

  return (
    <TrioScreen back title="Remote Control">
      <Section header="Buddy Remote Control">
        <ToggleWithHint
          label="Enable Remote Control"
          value={enabled}
          disabled={!loaded || secret.trim().length === 0}
          onChange={(v) => update({ remoteControlEnabled: v })}
          miniHint="Allow Buddy to receive commands from Loop Follow remotely."
          onHelp={() =>
            help.show({
              label: 'Enable Remote Control',
              body: (
                <HintParagraphs
                  boldFirst
                  lines={[
                    'Default: OFF',
                    'When Remote Control is enabled, you can send boluses, overrides, temporary targets, carbs, and other commands to Buddy via push notifications.',
                    'To ensure security, these commands are protected by a shared secret, which must be entered in the Loop Follow app. Every command is checked against your safety limits and rejected when it breaks them.',
                    'Push delivery needs credentials Buddy does not ship with. See the Remote Control section of the app README.',
                  ]}
                />
              ),
            })
          }
        />
      </Section>

      <Section header="Shared Secret">
        <Row>
          <TextInput
            value={secret}
            onChangeText={change}
            placeholder="Enter Shared Secret"
            placeholderTextColor={c.tertiary}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            selectionColor={c.tabBar}
            style={[styles.input, { color: c.primary }]}
            accessibilityLabel="Shared Secret"
          />
        </Row>
        <ButtonCard>
          <BorderedButton
            label="Copy Secret"
           
            onPress={() => {
              void Clipboard.setStringAsync(secret).then(() => Alert.alert('Copied', 'Shared Secret copied to clipboard'));
            }}
          />
        </ButtonCard>
        <ButtonCard>
          <BorderedButton label="Generate Secret" onPress={() => change(generateSharedSecret())} />
        </ButtonCard>
      </Section>
      <HintSheet hint={help.hint} onClose={help.close} />
    </TrioScreen>
  );
}

const styles = StyleSheet.create({ input: { flex: 1, fontSize: 17, paddingVertical: 0 } });
