import { SymbolView } from 'expo-symbols';
import type { PropsWithChildren } from 'react';
import { View } from 'react-native';
import { Row, T, useTrioColors } from '@/trio';

/** LoopKitUI `CheckmarkListItem`: title, description, checkmark circle on the right. */
export function ChoiceRow({ title, description, selected, onPress }: { title: string; description?: string; selected: boolean; onPress: () => void }) {
  const c = useTrioColors();
  return (
    <Row onPress={onPress} accessibilityLabel={title}>
      <View style={{ flex: 1, gap: 4 }}>
        <T style_="headline">{title}</T>
        {description ? (
          <T style_="footnote" secondary>
            {description}
          </T>
        ) : null}
      </View>
      <SymbolView name={selected ? 'checkmark.circle.fill' : 'circle'} size={26} tintColor={selected ? c.accent : c.tertiary} />
    </Row>
  );
}

/** Plain paragraph row inside a section (driver onboarding text). */
export function TextRow({ children, secondary }: PropsWithChildren<{ secondary?: boolean }>) {
  return (
    <Row>
      <T secondary={secondary} style={{ flex: 1 }}>
        {children}
      </T>
    </Row>
  );
}
