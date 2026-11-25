import { ActionSheetIOS, Alert, type AlertButton, type AlertOptions, Modal, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { create } from 'zustand';
import { useTrioColors } from './colors';
import { SymbolView } from './symbol';
import { T } from './text';

/*
 * Option pickers and action lists. iOS keeps the native action sheet (as in Trio). Android shows a
 * Material 3 dialog: `Alert.alert` there renders at most three buttons, which silently cut off
 * longer option lists.
 */

export interface ChoiceItem {
  readonly label: string;
  readonly destructive?: boolean;
}

interface Request {
  readonly title?: string;
  readonly message?: string;
  readonly items: readonly ChoiceItem[];
  /** Index of the current value: shown as a radio list when set, as an action list otherwise. */
  readonly selected?: number;
  readonly resolve: (index: number | null) => void;
}

const useChoice = create<{ request: Request | null; alert: AlertRequest | null }>(() => ({ request: null, alert: null }));

interface AlertRequest {
  readonly title: string;
  readonly message?: string;
  readonly buttons: readonly AlertButton[];
  readonly cancelable: boolean;
}

/*
 * Android: `Alert.alert` draws a legacy (teal, non-Material) dialog. Route it through the Material
 * dialog below so every confirmation in the app matches; iOS keeps the native UIAlertController.
 */
if (Platform.OS === 'android') {
  Alert.alert = (title: string, message?: string, buttons?: AlertButton[], options?: AlertOptions) => {
    const list = buttons && buttons.length > 0 ? buttons : [{ text: 'OK' }];
    useChoice.setState({ alert: { title, message, buttons: list, cancelable: options?.cancelable ?? list.some((b) => b.style === 'cancel') } });
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

/** Mounted once at the root; renders the Android dialog. */
export function ChoiceDialogHost() {
  if (Platform.OS === 'ios') return null;
  return (
    <>
      <ChoiceDialog />
      <AlertDialog />
    </>
  );
}

function AlertDialog() {
  const c = useTrioColors();
  const alert = useChoice((s) => s.alert);
  if (!alert) return null;
  const close = (button?: AlertButton) => {
    useChoice.setState({ alert: null });
    button?.onPress?.();
  };
  const dismiss = () => {
    if (alert.cancelable) close(alert.buttons.find((b) => b.style === 'cancel'));
  };
  return (
    <Modal transparent animationType="fade" statusBarTranslucent onRequestClose={dismiss}>
      <Pressable style={styles.scrim} onPress={dismiss} accessibilityLabel="Dismiss">
        <Pressable style={[styles.dialog, { backgroundColor: c.dark ? '#29292F' : '#EAE7EF' }]} onPress={() => {}}>
          <T style={styles.title} accessibilityRole="header">
            {alert.title}
          </T>
          {alert.message ? (
            <ScrollView style={{ maxHeight: 360 }}>
              <T style_="subheadline" secondary style={styles.message}>
                {alert.message}
              </T>
            </ScrollView>
          ) : null}
          <View style={[styles.actions, { flexWrap: 'wrap' }]}>
            {alert.buttons.map((b, i) => (
              <Pressable key={`${b.text}${i}`} onPress={() => close(b)} android_ripple={{ color: c.fill }} accessibilityRole="button" style={styles.cancel}>
                <T color={b.style === 'destructive' ? c.red : c.accent} style={{ fontWeight: '500' }}>
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

function ChoiceDialog() {
  const c = useTrioColors();
  const request = useChoice((s) => s.request);
  if (!request) return null;
  const close = (index: number | null) => {
    useChoice.setState({ request: null });
    request.resolve(index);
  };
  const radio = request.selected !== undefined;
  return (
    <Modal transparent animationType="fade" statusBarTranslucent onRequestClose={() => close(null)}>
      <Pressable style={styles.scrim} onPress={() => close(null)} accessibilityLabel="Dismiss">
        <Pressable style={[styles.dialog, { backgroundColor: c.dark ? '#29292F' : '#EAE7EF' }]} onPress={() => {}}>
          {request.title ? (
            <T style={styles.title} accessibilityRole="header">
              {request.title}
            </T>
          ) : null}
          {request.message ? (
            <T style_="subheadline" secondary style={styles.message}>
              {request.message}
            </T>
          ) : null}
          <ScrollView style={{ maxHeight: 420 }}>
            {request.items.map((item, i) => (
              <Pressable key={item.label} onPress={() => close(i)} android_ripple={{ color: c.fill }} accessibilityRole={radio ? 'radio' : 'button'} accessibilityState={radio ? { checked: i === request.selected } : undefined} style={styles.item}>
                {radio ? <SymbolView name={{ android: i === request.selected ? 'radio_button_checked' : 'radio_button_unchecked' }} size={24} tintColor={i === request.selected ? c.accent : c.secondary} /> : null}
                <T color={item.destructive ? c.red : undefined}>{item.label}</T>
              </Pressable>
            ))}
          </ScrollView>
          <View style={styles.actions}>
            <Pressable onPress={() => close(null)} android_ripple={{ color: c.fill }} accessibilityRole="button" style={styles.cancel}>
              <T color={c.accent} style={{ fontWeight: '500' }}>
                Cancel
              </T>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  dialog: { width: '100%', maxWidth: 400, borderRadius: 28, paddingTop: 24, paddingBottom: 12 },
  title: { fontSize: 24, fontWeight: '400', paddingHorizontal: 24, marginBottom: 12 },
  message: { paddingHorizontal: 24, marginBottom: 12 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 16, minHeight: 56, paddingHorizontal: 24 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', paddingHorizontal: 12, paddingTop: 8 },
  cancel: { paddingHorizontal: 12, height: 40, justifyContent: 'center', borderRadius: 20, overflow: 'hidden' },
});
