import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useRef } from 'react';
import { FlatList, StyleSheet, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { T, useTrioColors } from '@/trio';

const ITEM_HEIGHT = 34;
const VISIBLE_ROWS = 5;
const PAD = ((VISIBLE_ROWS - 1) / 2) * ITEM_HEIGHT;

interface Props {
  readonly count: number;
  readonly index: number;
  readonly label: (i: number) => string;
  readonly onChange: (i: number) => void;
  readonly disabled?: boolean;
  readonly accessibilityLabel: string;
}

/** `Picker(.wheel)` look-alike: snapping list with a highlighted centre row. */
export function WheelPicker({ count, index, label, onChange, disabled, accessibilityLabel }: Props) {
  const c = useTrioColors();
  const list = useRef<FlatList<number>>(null);
  const current = useRef(index);
  const data = useRef<number[]>([]);
  if (data.current.length !== count) data.current = Array.from({ length: count }, (_, i) => i);

  useEffect(() => {
    if (current.current === index) return;
    current.current = index;
    list.current?.scrollToOffset({ offset: index * ITEM_HEIGHT, animated: true });
  }, [index]);

  const settle = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const i = Math.max(0, Math.min(count - 1, Math.round(e.nativeEvent.contentOffset.y / ITEM_HEIGHT)));
      if (i === current.current) return;
      current.current = i;
      void Haptics.selectionAsync();
      onChange(i);
    },
    [count, onChange],
  );

  const step = (delta: number) => {
    const i = Math.max(0, Math.min(count - 1, current.current + delta));
    if (i !== current.current) onChange(i);
  };

  return (
    <View
      style={[styles.frame, disabled && { opacity: 0.5 }]}
      pointerEvents={disabled ? 'none' : 'auto'}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{ text: label(index) }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(e) => step(e.nativeEvent.actionName === 'increment' ? 1 : -1)}>
      <View pointerEvents="none" style={[styles.band, { backgroundColor: c.fill }]} />
      <FlatList
        ref={list}
        data={data.current}
        keyExtractor={(i) => String(i)}
        renderItem={({ item }) => (
          <View style={styles.item}>
            <T style={{ fontSize: 20 }} numberOfLines={1}>
              {label(item)}
            </T>
          </View>
        )}
        getItemLayout={(_, i) => ({ length: ITEM_HEIGHT, offset: ITEM_HEIGHT * i, index: i })}
        initialScrollIndex={Math.min(index, Math.max(0, count - 1))}
        snapToInterval={ITEM_HEIGHT}
        decelerationRate="fast"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingVertical: PAD }}
        onMomentumScrollEnd={settle}
        onScrollEndDrag={(e) => {
          if ((e.nativeEvent.velocity?.y ?? 0) === 0) settle(e);
        }}
        nestedScrollEnabled
        windowSize={5}
        initialNumToRender={VISIBLE_ROWS * 3}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { height: ITEM_HEIGHT * VISIBLE_ROWS, flex: 1, overflow: 'hidden' },
  band: { position: 'absolute', left: 4, right: 4, top: PAD, height: ITEM_HEIGHT, borderRadius: 8 },
  item: { height: ITEM_HEIGHT, alignItems: 'center', justifyContent: 'center' },
});
