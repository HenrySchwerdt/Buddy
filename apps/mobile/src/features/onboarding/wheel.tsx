import { Host, Picker, Text as SwiftText } from '@expo/ui/swift-ui';
import { pickerStyle, tag } from '@expo/ui/swift-ui/modifiers';
import * as Haptics from 'expo-haptics';
import { useEffect, useRef } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, View, type ScrollViewInstance, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { OB, OT } from './theme';

const ROW = 34;
const VISIBLE = 5;
export const WHEEL_HEIGHT = 216;

interface Props {
  readonly options: readonly number[];
  readonly value: number;
  readonly format: (v: number) => string;
  readonly onChange: (v: number) => void;
  readonly disabled?: boolean;
  readonly label: string;
}

/** SwiftUI `Picker(.wheel)`: native on iOS, a snapping list elsewhere. */
export function WheelPicker(props: Props) {
  if (Platform.OS === 'ios') return <NativeWheel {...props} />;
  return <ListWheel {...props} />;
}

function NativeWheel({ options, value, format, onChange, disabled, label }: Props) {
  return (
    <View style={{ height: WHEEL_HEIGHT, opacity: disabled ? 0.5 : 1 }} pointerEvents={disabled ? 'none' : 'auto'} accessibilityLabel={label}>
      <Host style={{ flex: 1 }} colorScheme="dark">
        <Picker selection={value} onSelectionChange={(v: number) => onChange(v)} modifiers={[pickerStyle('wheel')]}>
          {options.map((o) => (
            <SwiftText key={o} modifiers={[tag(o)]}>
              {format(o)}
            </SwiftText>
          ))}
        </Picker>
      </Host>
    </View>
  );
}

function ListWheel({ options, value, format, onChange, disabled, label }: Props) {
  const list = useRef<ScrollViewInstance>(null);
  const index = Math.max(0, options.indexOf(value));
  useEffect(() => {
    list.current?.scrollTo({ y: index * ROW, animated: false });
  }, [index]);
  const settle = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const i = Math.min(options.length - 1, Math.max(0, Math.round(e.nativeEvent.contentOffset.y / ROW)));
    if (options[i] !== undefined && options[i] !== value) {
      void Haptics.selectionAsync();
      onChange(options[i]!);
    }
  };
  const pad = ((VISIBLE - 1) / 2) * ROW;
  return (
    <View style={{ height: ROW * VISIBLE, opacity: disabled ? 0.5 : 1 }} pointerEvents={disabled ? 'none' : 'auto'} accessibilityLabel={label}>
      <View style={[styles.band, { top: pad, backgroundColor: OB.fill }]} />
      <ScrollView
        ref={list}
        contentOffset={{ x: 0, y: index * ROW }}
        snapToInterval={ROW}
        decelerationRate="fast"
        showsVerticalScrollIndicator={false}
        nestedScrollEnabled
        contentContainerStyle={{ paddingVertical: pad }}
        onMomentumScrollEnd={settle}>
        {options.map((item, i) => (
          <Pressable key={String(item)} style={styles.row} onPress={() => list.current?.scrollTo({ y: i * ROW, animated: true })}>
            <OT style={{ fontSize: 20 }} secondary={item !== value}>
              {format(item)}
            </OT>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { height: ROW, alignItems: 'center', justifyContent: 'center' },
  band: { position: 'absolute', left: 8, right: 8, height: ROW, borderRadius: 8 },
});
