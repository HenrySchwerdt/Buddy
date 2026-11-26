import { useState } from 'react';
import { ActionSheetIOS, Alert, type AlertButton, type AlertOptions, type AlertType, Modal, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { create } from 'zustand';
import { useTrioColors, type TrioColors } from './colors';
import { SheetModal } from './sheet-modal';
import { T } from './text';

/*
 * Option pickers, action lists and alerts. iOS keeps the native `UIAlertController` / action sheet
 * (as in Trio). Android has neither, so it draws the same controls in JS: a bottom action sheet
 * with a separate Cancel card, and a centred alert with divided buttons. `Alert.alert` is routed
 * through the JS alert so every confirmation in the app looks the same (and is not limited to the
 * three buttons Android's own dialog allows).
 */

export interface ChoiceItem {
  readonly label: string;
  readonly destructive?: boolean;
}

interface Request {
  readonly title?: string;
  readonly message?: string;
  readonly items: readonly ChoiceItem[];
  /** Index of the current value; shown in semibold. */
  readonly selected?: number;
  readonly resolve: (index: number | null) => void;
}

interface AlertRequest {
  readonly title: string;
  readonly message?: string;
  readonly buttons: readonly AlertButton[];
  readonly cancelable: boolean;
  /** Set for `Alert.prompt`: shows a text field and passes its text to the pressed button. */
  readonly prompt?: { readonly defaultValue: string; readonly secure: boolean };
}

const useChoice = create<{ request: Request | null; alert: AlertRequest | null }>(() => ({ request: null, alert: null }));

if (Platform.OS === 'android') {
  Alert.alert = (title: string, message?: string, buttons?: AlertButton[], options?: AlertOptions) => {
    const list = buttons && buttons.length > 0 ? buttons : [{ text: 'OK' }];
    useChoice.setState({ alert: { title, message, buttons: list, cancelable: options?.cancelable ?? list.some((b) => b.style === 'cancel') } });
  };
  // `Alert.prompt` is iOS-only in React Native; the JS alert gives Android the same text-field alert.
  Alert.prompt = (title: string, message?: string, callbackOrButtons?: ((text: string) => void) | AlertButton[], type?: AlertType, defaultValue?: string) => {
    const buttons: AlertButton[] =
      typeof callbackOrButtons === 'function'
        ? [{ text: 'Cancel', style: 'cancel' }, { text: 'OK', onPress: (t?: string) => callbackOrButtons(t ?? '') }]
        : callbackOrButtons && callbackOrButtons.length > 0
          ? [...callbackOrButtons]
          : [{ text: 'OK' }];
    useChoice.setState({ alert: { title, message, buttons, cancelable: buttons.some((b) => b.style === 'cancel'), prompt: { defaultValue: defaultValue ?? '', secure: type === 'secure-text' } } });
  };
}

/** Asks the user to pick one item; resolves its index, or null when cancelled. */
export function choose(opts: Omit<Request, 'resolve'>): Promise<number | null> {
  if (Platform.OS === 'ios') {
    return new Promise((resolve) => {
      const destructiveButtonIndex = opts.items.map((a, i) => (a.destructive ? i : -1)).filter((i) => i >= 0);
      ActionSheetIOS.showActionSheetWithOptions(
        { title: opts.title, message: opts.message, options: [...opts.items.map((i) => i.label), 'Cancel'], cancelButtonIndex: opts.items.length, destructiveButtonIndex },
        (i) => resolve(i < opts.items.length ? i : null),
      );
    });
  }
  return new Promise((resolve) => {
    useChoice.getState().request?.resolve(null);
    useChoice.setState({ request: { ...opts, resolve } });
  });
}

/** Picks one of `options`; calls `onChange` with its value unless cancelled. */
export function chooseValue<V>(title: string, options: readonly { value: V; label: string }[], current: V, onChange: (v: V) => void): void {
  void choose({ title, items: options, selected: options.findIndex((o) => o.value === current) }).then((i) => {
    if (i !== null) onChange(options[i]!.value);
  });
}

/** Mounted once at the root; renders the Android action sheet and alert. */
export function ChoiceDialogHost() {
  if (Platform.OS === 'ios') return null;
  return (
    <>
      <ActionSheet />
      <IosAlert />
    </>
  );
}

/** iOS translucent popover surface. */
const surface = (c: TrioColors) => (c.dark ? '#2C2C2E' : '#F6F6F8');
const IOS_BLUE = (c: TrioColors) => (c.dark ? '#0A84FF' : '#007AFF');

function ActionSheet() {
  const c = useTrioColors();
  const request = useChoice((s) => s.request);
  if (!request) return null;
  const finish = (index: number | null) => request.resolve(index);
  return (
    <SheetModal onClosed={() => useChoice.setState({ request: null })}>
      {(dismiss) => (
        <View style={{ gap: 8 }}>
          <View style={[styles.group, { backgroundColor: surface(c) }]}>
            {request.title || request.message ? (
              <View style={[styles.header, { borderBottomColor: c.separator }]}>
                {request.title ? (
                  <T style_="footnote" secondary align="center" weight="600">
                    {request.title}
                  </T>
                ) : null}
                {request.message ? (
                  <T style_="footnote" secondary align="center">
                    {request.message}
                  </T>
                ) : null}
              </View>
            ) : null}
            <ScrollView style={{ maxHeight: 440 }} bounces={false}>
              {request.items.map((item, i) => (
                <Pressable
                  key={`${item.label}${i}`}
                  accessibilityRole="button"
                  accessibilityState={request.selected !== undefined ? { selected: i === request.selected } : undefined}
                  onPress={() => dismiss(() => finish(i))}
                  style={({ pressed }) => [styles.item, i > 0 && { borderTopColor: c.separator, borderTopWidth: StyleSheet.hairlineWidth }, pressed && { backgroundColor: c.fill }]}>
                  <T size={20} color={item.destructive ? c.red : IOS_BLUE(c)} weight={i === request.selected ? '600' : '400'} numberOfLines={1}>
                    {item.label}
                  </T>
                </Pressable>
              ))}
            </ScrollView>
          </View>
          <Pressable accessibilityRole="button" onPress={() => dismiss(() => finish(null))} style={({ pressed }) => [styles.group, styles.item, { backgroundColor: pressed ? c.fill : surface(c) }]}>
            <T size={20} weight="600" color={IOS_BLUE(c)}>
              Cancel
            </T>
          </Pressable>
        </View>
      )}
    </SheetModal>
  );
}

function IosAlert() {
  const c = useTrioColors();
  const alert = useChoice((s) => s.alert);
  const [text, setText] = useState('');
  const [shown, setShown] = useState<AlertRequest | null>(null);
  if (alert !== shown) {
    setShown(alert);
    setText(alert?.prompt?.defaultValue ?? '');
  }
  if (!alert) return null;
  const close = (button?: AlertButton) => {
    useChoice.setState({ alert: null });
    button?.onPress?.(alert.prompt ? text : undefined);
  };
  const dismiss = () => {
    if (alert.cancelable) close(alert.buttons.find((b) => b.style === 'cancel'));
  };
  // UIKit: two buttons sit side by side, three or more stack; the cancel button is semibold.
  const stacked = alert.buttons.length !== 2;
  const preferred = alert.buttons.find((b) => b.isPreferred);
  return (
    <Modal transparent animationType="fade" statusBarTranslucent navigationBarTranslucent onRequestClose={dismiss}>
      <Pressable style={styles.scrim} onPress={dismiss} accessibilityLabel="Dismiss">
        <Pressable style={[styles.alert, { backgroundColor: surface(c) }]} onPress={() => {}} accessibilityRole="alert">
          <View style={styles.alertBody}>
            <T style_="headline" align="center" accessibilityRole="header">
              {alert.title}
            </T>
            {alert.message ? (
              <ScrollView style={{ maxHeight: 320 }} bounces={false}>
                <T style_="footnote" align="center" style={{ marginTop: 4 }}>
                  {alert.message}
                </T>
              </ScrollView>
            ) : null}
            {alert.prompt ? (
              <TextInput
                value={text}
                onChangeText={setText}
                autoFocus
                secureTextEntry={alert.prompt.secure}
                selectionColor={c.tabBar}
                accessibilityLabel={alert.title}
                style={[styles.promptInput, { color: c.primary, backgroundColor: c.dark ? '#1C1C1E' : '#FFFFFF', borderColor: c.separator }]}
              />
            ) : null}
          </View>
          <View style={{ flexDirection: stacked ? 'column' : 'row' }}>
            {alert.buttons.map((b, i) => (
              <Pressable
                key={`${b.text}${i}`}
                accessibilityRole="button"
                onPress={() => close(b)}
                style={({ pressed }) => [
                  styles.alertButton,
                  { borderTopColor: c.separator, borderTopWidth: StyleSheet.hairlineWidth },
                  !stacked && i > 0 && { borderLeftColor: c.separator, borderLeftWidth: StyleSheet.hairlineWidth },
                  !stacked && { flex: 1 },
                  pressed && { backgroundColor: c.fill },
                ]}>
                <T size={17} color={b.style === 'destructive' ? c.red : IOS_BLUE(c)} weight={b.style === 'cancel' || b === preferred ? '600' : '400'}>
                  {b.text}
                </T>
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  alert: { width: 270, borderRadius: 14, overflow: 'hidden' },
  alertBody: { paddingHorizontal: 16, paddingTop: 20, paddingBottom: 16, alignItems: 'center' },
  promptInput: { alignSelf: 'stretch', marginTop: 12, height: 32, paddingHorizontal: 8, paddingVertical: 0, fontSize: 15, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth },
  alertButton: { minHeight: 44, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
  group: { borderRadius: 14, overflow: 'hidden' },
  header: { paddingHorizontal: 16, paddingVertical: 14, gap: 2, borderBottomWidth: StyleSheet.hairlineWidth },
  item: { minHeight: 57, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
});
