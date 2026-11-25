import { useState } from 'react';
import { Modal } from 'react-native';
import { CapsuleButton, InputRow, Section, SheetScreen, useTrioColors } from '@/trio';
import { sanitizeInteger } from './rows';
import { TreatmentButton } from './treatment-button';
import type { MealPreset } from './presets-store';

/** Port of Trio's `AddMealPresetView`. */
export function AddPresetSheet({ visible, showFatProtein, onSave, onCancel }: { visible: boolean; showFatProtein: boolean; onSave: (p: Omit<MealPreset, 'id'>) => void; onCancel: () => void }) {
  const c = useTrioColors();
  const [dish, setDish] = useState('');
  const [carbs, setCarbs] = useState('');
  const [fat, setFat] = useState('');
  const [protein, setProtein] = useState('');
  const n = (s: string) => Number(s) || 0;
  const valid = dish !== '' && (n(carbs) > 0 || n(fat) > 0 || n(protein) > 0);
  const reset = () => {
    setDish('');
    setCarbs('');
    setFat('');
    setProtein('');
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onCancel}>
      <SheetScreen
        title="Add Meal Preset"
        leading={
          <CapsuleButton
            label="Cancel"
            color={c.primary}
            onPress={() => {
              reset();
              onCancel();
            }}
          />
        }>
        <Section header="New Preset">
          <InputRow value={dish} onChangeText={setDish} placeholder="Name Of Dish" keyboardType="default" maxLength={25} />
        </Section>
        <Section>
          <InputRow label="Carbs" value={carbs} onChangeText={(t) => setCarbs(sanitizeInteger(t))} unit="g" keyboardType="number-pad" maxLength={3} />
          {showFatProtein ? <InputRow label="Fat" value={fat} onChangeText={(t) => setFat(sanitizeInteger(t))} unit="g" keyboardType="number-pad" maxLength={3} /> : null}
          {showFatProtein ? <InputRow label="Protein" value={protein} onChangeText={(t) => setProtein(sanitizeInteger(t))} unit="g" keyboardType="number-pad" maxLength={3} /> : null}
        </Section>
        <TreatmentButton
          label="Save"
          disabled={!valid}
          limitExceeded={false}
          onPress={() => {
            onSave({ dish, carbs: n(carbs), fat: showFatProtein ? n(fat) : 0, protein: showFatProtein ? n(protein) : 0 });
            reset();
          }}
        />
      </SheetScreen>
    </Modal>
  );
}
