import { useEffect, useState } from 'react';
import { StyleSheet, TextInput } from 'react-native';
import { isTidepoolError } from '@buddy/tidepool';
import { BorderedButton, ButtonCard, HintParagraphs, HintSheet, ToggleWithHint, useHint } from '@/features/settings-b/ui';
import { useSettings } from '@/runtime/settings-store';
import { refreshTidepoolStatus, tidepoolLogin, tidepoolLogout, tidepoolRedirectUri, useTidepoolStatus } from '@/runtime/tidepool';
import { PickerRow, Row, Section, T, TrioScreen, ValueRow, useTrioColors } from '@/trio';

/** Trio TidepoolConfigView / TidepoolStartView: sign in to Tidepool and upload glucose, insulin and carbs. */
export default function TidepoolScreen() {
  const c = useTrioColors();
  const help = useHint();
  const clientId = useSettings((s) => s.tidepoolClientId);
  const environment = useSettings((s) => s.tidepoolEnvironment);
  const upload = useSettings((s) => s.tidepoolUpload);
  const update = useSettings((s) => s.update);
  const status = useTidepoolStatus();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    void refreshTidepoolStatus();
  }, [clientId]);

  const signIn = async () => {
    setBusy(true);
    setMessage('');
    try {
      await tidepoolLogin();
      await refreshTidepoolStatus();
    } catch (e) {
      // Closing the browser sheet is not an error.
      if (!(isTidepoolError(e) && e.code === 'login-cancelled')) setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    setBusy(true);
    try {
      await tidepoolLogout();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const uploadText = status.lastError ? 'Failed' : status.lastOk ? new Date(status.lastOk).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'Waiting';

  return (
    <TrioScreen back title="Tidepool">
      {!status.signedIn ? (
        <>
          <Section
            header="Tidepool Account"
            footer={
              clientId.trim()
                ? `Signing in opens Tidepool in the browser. The redirect address ${tidepoolRedirectUri()} must be registered for this client id.`
                : `Buddy has no Tidepool login of its own yet. To upload, a client has to be registered with Tidepool for Buddy with the redirect address ${tidepoolRedirectUri()}. Enter its OAuth client id here. Do not use the id of another app.`
            }>
            <Row>
              <TextInput
                value={clientId}
                onChangeText={(v) => update({ tidepoolClientId: v.trim() })}
                placeholder="OAuth client id"
                placeholderTextColor={c.tertiary}
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                selectionColor={c.tabBar}
                style={[styles.input, { color: c.primary }]}
                accessibilityLabel="OAuth client id"
              />
            </Row>
            <PickerRow
              label="Server"
              value={environment}
              options={[
                { value: 'production', label: 'Tidepool' },
                { value: 'integration', label: 'Integration' },
              ]}
              onChange={(v) => update({ tidepoolEnvironment: v })}
            />
            {message ? (
              <Row>
                <T color={c.red} style={{ flex: 1 }}>
                  {message}
                </T>
              </Row>
            ) : null}
            <ButtonCard>
              <BorderedButton label="Log in & Connect" onPress={() => void signIn()} disabled={clientId.trim().length === 0} loading={busy} />
            </ButtonCard>
          </Section>
        </>
      ) : (
        <>
          {status.reauthRequired ? (
            <Section>
              <Row>
                <T color={c.red} style={{ flex: 1 }}>
                  Sign in to Tidepool again. Your session has expired.
                </T>
              </Row>
              <ButtonCard>
                <BorderedButton label="Log in again" onPress={() => void signIn()} loading={busy} />
              </ButtonCard>
            </Section>
          ) : null}
          <Section header="Tidepool Account">
            <ValueRow label="Signed in as" value={status.username || 'Tidepool user'} />
          </Section>
          <Section>
            <ToggleWithHint
              label="Allow Uploading to Tidepool"
              value={upload}
              onChange={(v) => update({ tidepoolUpload: v })}
              miniHint="Upload glucose, insulin and carbs to Tidepool after every loop."
              onHelp={() =>
                help.show({
                  label: 'Allow Uploading to Tidepool',
                  body: <HintParagraphs boldFirst lines={['Default: OFF', 'Glucose readings, boluses, basal rates, carbs and your pump settings are uploaded to your Tidepool account. Deleting a record in Buddy deletes it in Tidepool too.']} />,
                })
              }
            />
          </Section>
          <Section header="Upload Status" footer={upload && status.lastError ? status.lastError : message || undefined}>
            <ValueRow label="Last Upload" value={upload ? uploadText : 'Off'} valueColor={upload && status.lastError ? c.red : undefined} />
          </Section>
          <Section>
            <ButtonCard>
              <BorderedButton label="Log out" color={c.loopRed} onPress={() => void signOut()} loading={busy} />
            </ButtonCard>
          </Section>
        </>
      )}
      <HintSheet hint={help.hint} onClose={help.close} />
    </TrioScreen>
  );
}

const styles = StyleSheet.create({ input: { flex: 1, fontSize: 17, paddingVertical: 0 } });
