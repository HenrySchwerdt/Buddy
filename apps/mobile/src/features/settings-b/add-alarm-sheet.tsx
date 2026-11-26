import { Modal, View } from 'react-native';
import { CapsuleButton, Row, Section, SheetScreen, T, useTrioColors } from '@/trio';
import { SymbolView } from '@/trio/symbol';
import { addableKinds, metaFor, type GlucoseAlarm, type GlucoseAlarmKind } from './alarms';

/** AddGlucoseAlertSheet: pick the type of the new alarm. Types with every window taken are listed as unavailable. */
export function AddAlarmSheet({ visible, alarms, onPick, onClose }: { visible: boolean; alarms: readonly GlucoseAlarm[]; onPick: (kind: GlucoseAlarmKind) => void; onClose: () => void }) {
  const c = useTrioColors();
  const { available, unavailable } = addableKinds(alarms);
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SheetScreen title="Add Alarm" leading={<CapsuleButton label="Cancel" onPress={onClose} />}>
        {available.length ? (
          <Section header="Available">
            {available.map((kind) => (
              <Row key={kind} onPress={() => onPick(kind)} accessibilityLabel={`${metaFor(kind).name}. ${metaFor(kind).blurb}`}>
                <View style={{ flex: 1, gap: 2 }}>
                  <T>{metaFor(kind).name}</T>
                  <T style_="footnote" secondary>
                    {metaFor(kind).blurb}
                  </T>
                </View>
                <SymbolView name="chevron.right" size={13} tintColor={c.secondary} weight="semibold" />
              </Row>
            ))}
          </Section>
        ) : null}
        {unavailable.length ? (
          <Section header="Unavailable" footer="Already set for Day & Night. Change the alarm window to add a second alarm for the same type.">
            {unavailable.map((kind) => (
              <Row key={kind} accessibilityLabel={`${metaFor(kind).name}, unavailable`} style={{ opacity: 0.5 }}>
                <View style={{ flex: 1, gap: 2 }}>
                  <T>{metaFor(kind).name}</T>
                  <T style_="footnote" secondary>
                    {metaFor(kind).blurb}
                  </T>
                </View>
              </Row>
            ))}
          </Section>
        ) : null}
      </SheetScreen>
    </Modal>
  );
}
