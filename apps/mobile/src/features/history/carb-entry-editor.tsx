import { useEffect, useState } from 'react';
import { Modal, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { CarbEntry } from '@buddy/core';
import { CapsuleButton, InputRow, PrimaryButton, Section, SheetScreen, ValueRow, useTrioColors } from '@/trio';
import { updateCarbs } from './actions';
import { upTo2 } from './rows';

/** Trio's default `maxCarbs` (Buddy has no carb limit setting yet). */
const MAX_CARBS_G = 250;

/** CarbEntryEditorView ("Edit Meal"), carbs only: Buddy records neither fat/protein nor notes. */
export function CarbEntryEditor({ entry, onClose }: { entry: CarbEntry | null; onClose: () => void }) {
  const c = useTrioColors();
  const insets = useSafeAreaInsets();
  const [text, setText] = useState('');
  useEffect(() => setText(entry ? upTo2(entry.grams) : ''), [entry]);
  const grams = Number(text.replace(',', '.'));
  const valid = text.trim() !== '' && Number.isFinite(grams) && grams >= 0;
  const exceeded = valid && grams > MAX_CARBS_G;
  return (
    <Modal visible={entry !== null} presentationStyle="pageSheet" animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: c.bgBottom }}>
        <SheetScreen
          title="Edit Meal"
          leading={<CapsuleButton label="Cancel" color={c.tabBar} onPress={onClose} />}
          footer={
            <View style={{ paddingBottom: insets.bottom }}>
              <PrimaryButton
                label={exceeded ? `Max Carbs of ${MAX_CARBS_G} g Exceeded` : 'Save and Update'}
                disabled={!valid || exceeded}
                onPress={() => {
                  if (!entry) return;
                  updateCarbs(entry, grams, entry.date);
                  onClose();
                }}
              />
            </View>
          }>
          <Section>
            <InputRow label="Carbs" value={text} onChangeText={setText} unit="g" keyboardType="number-pad" />
          </Section>
          <Section>
            <ValueRow label="Time" value={entry ? new Date(entry.date).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''} />
          </Section>
        </SheetScreen>
      </View>
    </Modal>
  );
}
