import * as Haptics from 'expo-haptics';
import { SymbolView } from 'expo-symbols';
import { Modal, Pressable, View } from 'react-native';
import { now } from '@/runtime/runtime';
import { useSettings } from '@/runtime/settings-store';
import { CapsuleButton, NavRow, Row, Section, SheetScreen, T, useTrioColors } from '@/trio';
import { endSnooze, formatTimeOfDay, SNOOZE_ACTIONS, snoozeAll, snoozedUntil } from './snooze';

/** SnoozeAlertsSheetView: pick a duration to mute every Buddy alarm. */
export function SnoozeAlertsSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      {visible ? <SheetBody onClose={onClose} /> : null}
    </Modal>
  );
}

function SheetBody({ onClose }: { onClose: () => void }) {
  const c = useTrioColors();
  const snoozes = useSettings((s) => s.alertSnoozes);
  const until = snoozedUntil(snoozes, now());

  return (
    <SheetScreen title="Snooze Alerts" leading={<View />} trailing={<CapsuleButton label="Close" onPress={onClose} />}>
      {until !== null ? (
        <Section
          footer={
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <SymbolView name="hand.tap.fill" size={14} tintColor={c.primary} />
              <T style_="footnote" secondary>
                Tap End Snooze to end snooze.
              </T>
            </View>
          }>
          <Row>
            <SymbolView name="moon.zzz.fill" size={20} tintColor={c.tabBar} />
            <T style_="headline" style={{ flex: 1 }}>
              Snoozed until {formatTimeOfDay(until)}
            </T>
            <Pressable
              onPress={() => {
                void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
                endSnooze();
              }}
              accessibilityRole="button"
              accessibilityLabel="End Snooze"
              style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, backgroundColor: c.red, opacity: pressed ? 0.7 : 1 })}>
              <SymbolView name="alarm.waves.left.and.right.fill" size={14} tintColor="#fff" />
              <T style_="subheadline" color="#fff">
                End Snooze
              </T>
            </Pressable>
          </Row>
        </Section>
      ) : null}
      <Section footer="Pick a duration to mute every Buddy alarm. Critical alerts (e.g. urgent low) still pierce the snooze.">
        {SNOOZE_ACTIONS.map((a) => (
          <NavRow
            key={a.minutes}
            label={a.title}
            onPress={() => {
              snoozeAll(a.minutes, now());
              onClose();
            }}
          />
        ))}
      </Section>
    </SheetScreen>
  );
}
