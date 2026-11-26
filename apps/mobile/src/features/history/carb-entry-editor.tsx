import { useEffect, useState } from 'react';
import { Modal, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { CarbEntry } from '@buddy/core';
import { useTreatmentSettings } from '@/features/treatment/settings-store';
import { CapsuleButton, InputRow, PrimaryButton, Section, SheetScreen, ValueRow, useTrioColors } from '@/trio';
import { updateCarbs } from './actions';
import { upTo2 } from './rows';

/** Trio's `TextFieldWithToolBarString(maxLength: 25)`. */
const MAX_NOTE_LENGTH = 25;

/** CarbEntryEditorView ("Edit Meal"): carbs and note (Buddy does not record fat/protein). */
export function CarbEntryEditor({ entry, onClose }: { entry: CarbEntry | null; onClose: () => void }) {
  const c = useTrioColors();
  const insets = useSafeAreaInsets();
  // Meal Settings > Max Carbs (Trio's maxCarbs).
  const maxCarbs = useTreatmentSettings((t) => t.maxCarbs);
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  useEffect(() => {
    setText(entry ? upTo2(entry.grams) : '');
    setNote(entry?.note ?? '');
  }, [entry]);
  const grams = Number(text.replace(',', '.'));
  const valid = text.trim() !== '' && Number.isFinite(grams) && grams >= 0;
  const exceeded = valid && grams > maxCarbs;
  return (
    <Modal visible={entry !== null} presentationStyle="pageSheet" animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: c.bgBottom }}>
        <SheetScreen
          title="Edit Meal"
          leading={<CapsuleButton label="Cancel" color={c.tabBar} onPress={onClose} />}
          footer={
            <View style={{ paddingBottom: insets.bottom }}>
              <PrimaryButton
                label={exceeded ? `Max Carbs of ${maxCarbs} g Exceeded` : 'Save and Update'}
                disabled={!valid || exceeded}
                onPress={() => {
                  if (!entry) return;
                  updateCarbs(entry, grams, entry.date, note);
                  onClose();
                }}
              />
            </View>
          }>
          <Section>
            <InputRow label="Carbs" value={text} onChangeText={setText} unit="g" keyboardType="number-pad" />
            <InputRow icon="square.and.pencil" value={note} onChangeText={setNote} placeholder="Note..." keyboardType="default" maxLength={MAX_NOTE_LENGTH} />
          </Section>
          <Section>
            <ValueRow label="Time" value={entry ? new Date(entry.date).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''} />
          </Section>
        </SheetScreen>
      </View>
    </Modal>
  );
}
