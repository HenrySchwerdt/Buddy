import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Platform, StatusBar as RNStatusBar, View } from 'react-native';
import { currentShortcutState } from '@/runtime/background';
import { useRuntime } from '@/runtime/runtime';
import { useSettings } from '@/runtime/settings-store';
import { confirmShortcut, prepare } from '@/runtime/shortcuts';
import { parseShortcutParams } from '@/runtime/shortcuts-link';
import { describeState } from '@/runtime/shortcuts-state';
import { useTheme } from '@/theme/use-theme';
import { CapsuleButton, NextButton, Row, Section, SheetScreen, T, useTrioColors } from '@/trio';

const leave = () => (router.canGoBack() ? router.back() : router.replace('/'));

/**
 * In-app confirmation for `buddy://shortcut?...` links, iOS App Intents and Android app shortcuts.
 * The link only describes what it wants. Nothing is delivered or changed until the user presses the
 * confirm button here, and the action is validated again at that moment (limits, max IOB, recent boluses).
 */
export default function ShortcutScreen() {
  const theme = useTheme();
  const c = useTrioColors();
  const params = useLocalSearchParams();
  const onboarded = useSettings((s) => s.onboarded);
  const ready = useRuntime((s) => s.ready);
  const parsed = useMemo(() => parseShortcutParams(params as Record<string, string | string[] | undefined>), [params]);
  // Prepared once the runtime is ready; the confirm button validates again.
  const prepared = useMemo(() => (parsed.ok && ready && onboarded ? prepare(parsed.action) : null), [parsed, ready, onboarded]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const autoRan = useRef(false);
  // State updates are asynchronous: a quick double tap would otherwise start the action twice.
  const confirming = useRef(false);

  const options = (
    <Stack.Screen
      options={{ presentation: 'modal', headerShown: false, contentStyle: { backgroundColor: theme.bgBottom, paddingTop: Platform.OS === 'android' ? (RNStatusBar.currentHeight ?? 0) : 0 } }}
    />
  );

  // Actions without insulin or dosing effect (restart Live Activity) run as soon as the screen is shown.
  useEffect(() => {
    if (!parsed.ok || !prepared?.ok || autoRan.current || prepared.needsConfirmation || prepared.plan.type !== 'restartLiveActivity') return;
    autoRan.current = true;
    setBusy(true);
    void confirmShortcut(parsed.action).then((r) => {
      setResult(r);
      setBusy(false);
    });
  }, [parsed, prepared]);

  const close = <CapsuleButton label="Close" onPress={leave} />;

  if (!onboarded) {
    return (
      <>
        {options}
        <SheetScreen title="Shortcut" leading={close}>
          <Section>
            <Row>
              <T>Finish setting up Buddy first. Nothing was done.</T>
            </Row>
          </Section>
        </SheetScreen>
      </>
    );
  }
  if (!parsed.ok) {
    return (
      <>
        {options}
        <SheetScreen title="Shortcut" leading={close}>
          <Section>
            <Row>
              <T color={c.red}>{parsed.error}</T>
            </Row>
          </Section>
        </SheetScreen>
      </>
    );
  }
  if (!prepared) {
    return (
      <>
        {options}
        <SheetScreen title="Shortcut" leading={close}>
          <View style={{ alignItems: 'center', padding: 24 }}>
            <ActivityIndicator />
          </View>
        </SheetScreen>
      </>
    );
  }
  if (!prepared.ok) {
    return (
      <>
        {options}
        <SheetScreen title={prepared.title} leading={close}>
          <Section>
            <Row>
              <T color={c.red}>{prepared.error}</T>
            </Row>
          </Section>
          <T style_="footnote" secondary>
            Nothing was done.
          </T>
        </SheetScreen>
      </>
    );
  }

  if (prepared.plan.type === 'state') {
    const state = currentShortcutState();
    return (
      <>
        {options}
        <SheetScreen title={prepared.title} leading={close}>
          <Section>
            {(state ? describeState(state) : ['No data yet.']).map((line) => (
              <Row key={line}>
                <T>{line}</T>
              </Row>
            ))}
          </Section>
        </SheetScreen>
      </>
    );
  }

  const confirm = async () => {
    if (confirming.current || busy || result?.ok || !parsed.ok) return;
    confirming.current = true;
    setBusy(true);
    try {
      setResult(await confirmShortcut(parsed.action));
    } finally {
      confirming.current = false;
      setBusy(false);
    }
  };

  return (
    <>
      {options}
      <SheetScreen
        title={prepared.title}
        leading={result?.ok ? null : <CapsuleButton label="Cancel" onPress={leave} />}
        footer={
          result?.ok ? (
            <NextButton label="Done" onPress={leave} />
          ) : prepared.needsConfirmation ? (
            <NextButton label={busy ? 'Working…' : prepared.confirmLabel} onPress={() => void confirm()} disabled={busy} />
          ) : null
        }>
        <Section header={prepared.insulin ? 'Confirm insulin delivery' : 'Confirm'}>
          {prepared.lines.map((line) => (
            <Row key={line}>
              <T>{line}</T>
            </Row>
          ))}
        </Section>
        <T style_="footnote" secondary>
          This request came from a shortcut or link. It is only carried out if you confirm it here.
        </T>
        {result ? (
          <Section>
            <Row>
              <T color={result.ok ? c.green : c.red}>{result.message}</T>
            </Row>
          </Section>
        ) : null}
      </SheetScreen>
    </>
  );
}
