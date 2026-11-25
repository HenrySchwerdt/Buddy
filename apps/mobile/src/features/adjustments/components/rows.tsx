import * as Haptics from 'expo-haptics';
import { SymbolView } from 'expo-symbols';
import { Fragment, type ReactNode } from 'react';
import { ActionSheetIOS, Alert, Platform, Pressable, StyleSheet, View } from 'react-native';
import Swipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';
import { T, useTrioColors } from '@/trio';

const ACTION_WIDTH = 74;

/** Native action sheet (Trio's `.glassActionSheet` / `.contextMenu`). Last button is Cancel. */
export function actionSheet(opts: { title?: string; message?: string; actions: readonly { label: string; destructive?: boolean; onPress: () => void }[] }) {
  const labels = [...opts.actions.map((a) => a.label), 'Cancel'];
  if (Platform.OS === 'ios') {
    const destructiveButtonIndex = opts.actions.map((a, i) => (a.destructive ? i : -1)).filter((i) => i >= 0);
    ActionSheetIOS.showActionSheetWithOptions({ title: opts.title, message: opts.message, options: labels, cancelButtonIndex: opts.actions.length, destructiveButtonIndex }, (i) => {
      if (i < opts.actions.length) opts.actions[i]!.onPress();
    });
    return;
  }
  Alert.alert(opts.title ?? '', opts.message, [...opts.actions.map((a) => ({ text: a.label, style: a.destructive ? ('destructive' as const) : ('default' as const), onPress: a.onPress })), { text: 'Cancel', style: 'cancel' as const }]);
}

/** List row with Trio's trailing swipe actions: Delete (red) and Edit (blue). */
export function SwipeRow({ children, onDelete, onEdit }: { children: ReactNode; onDelete: () => void; onEdit: () => void }) {
  const c = useTrioColors();
  const action = (label: string, icon: 'trash.fill' | 'pencil', color: string, run: () => void, methods: SwipeableMethods) => (
    <Pressable
      key={label}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => {
        methods.close();
        run();
      }}
      style={[styles.action, { backgroundColor: color }]}>
      <SymbolView name={icon} size={20} tintColor="#fff" />
    </Pressable>
  );
  return (
    <Swipeable
      friction={2}
      rightThreshold={40}
      overshootRight={false}
      renderRightActions={(_p, _t, methods) => (
        <View style={styles.actions}>
          {action('Delete', 'trash.fill', c.red, onDelete, methods)}
          {action('Edit', 'pencil', c.accent, onEdit, methods)}
        </View>
      )}>
      <View style={{ backgroundColor: c.chart }}>{children}</View>
    </Swipeable>
  );
}

/** Name + caption labels separated by thin dividers, trailing drag handle or green checkmark. */
export function PresetRow({ name, labels, trailingNote, checked, onPress, onLongPress, accessibilityHint, showHandle = true }: { name: string; labels: readonly string[]; trailingNote?: string; checked: boolean; onPress?: () => void; onLongPress?: () => void; accessibilityHint?: string; showHandle?: boolean }) {
  const c = useTrioColors();
  return (
    <Pressable
      onPress={
        onPress
          ? () => {
              void Haptics.selectionAsync();
              onPress();
            }
          : undefined
      }
      onLongPress={onLongPress}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={name}
      accessibilityValue={{ text: labels.join(', ') }}
      accessibilityHint={accessibilityHint}
      style={({ pressed }) => [styles.preset, pressed && onPress ? { backgroundColor: c.fill } : null]}>
      <View style={{ flex: 1, gap: 2 }}>
        <View style={styles.titleLine}>
          <T style={{ flex: 1 }} numberOfLines={1}>
            {name}
          </T>
          {trailingNote ? <T color={c.dark ? c.orange : c.accent}>{trailingNote}</T> : null}
        </View>
        <View style={styles.labels}>
          {labels.map((l, i) => (
            <Fragment key={`${l}-${i}`}>
              <T style_="caption" secondary>
                {l}
              </T>
              {i < labels.length - 1 ? <View style={[styles.divider, { backgroundColor: c.separator }]} /> : null}
            </Fragment>
          ))}
        </View>
      </View>
      {checked ? (
        <SymbolView name="checkmark.circle.fill" size={24} tintColor={c.green} weight="bold" />
      ) : showHandle ? (
        <SymbolView name="line.3.horizontal" size={17} tintColor={c.secondary} />
      ) : null}
    </Pressable>
  );
}

/** Section footer with the hand icon: "Swipe left to edit or delete …". */
export function SwipeHintFooter({ text }: { text: string }) {
  const c = useTrioColors();
  return (
    <View style={styles.footer}>
      <SymbolView name="hand.draw.fill" size={14} tintColor={c.primary} />
      <T style_="footnote" secondary style={{ flex: 1 }}>
        {text}
      </T>
    </View>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row' },
  action: { width: ACTION_WIDTH, alignItems: 'center', justifyContent: 'center' },
  preset: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingVertical: 11 },
  titleLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  labels: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 5, paddingTop: 2 },
  divider: { width: 1, height: 14 },
  footer: { flexDirection: 'row', alignItems: 'center', gap: 8 },
});
