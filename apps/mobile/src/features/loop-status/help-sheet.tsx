import { Modal, View } from 'react-native';
import { CapsuleButton, Row, Section, SheetScreen, T, useTrioColors } from '@/trio';
import { GLOSSARY, GLOSSARY_INTRO, type GlossaryColor } from './glossary';

/** LoopStatusHelpView: glossary of the terms in oref's reason, one card per term. */
export function LoopStatusHelpSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const c = useTrioColors();
  const color: Record<GlossaryColor, string> = { insulin: c.insulin, zt: c.purple, green: c.green, gray: c.secondary };
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SheetScreen title="Glossary" trailing={<CapsuleButton label="Got it!" onPress={onClose} />}>
        <T style_="subheadline" secondary style={{ paddingHorizontal: 4 }}>
          {GLOSSARY_INTRO}
        </T>
        <Section>
          {GLOSSARY.map((g) => (
            <Row key={g.term} accessibilityLabel={`${g.term}. ${g.definition}`}>
              <View style={{ flex: 1, gap: 4 }}>
                <T weight="700" color={color[g.color]}>
                  {g.term}
                </T>
                <T style_="footnote" secondary>
                  {g.definition}
                </T>
              </View>
            </Row>
          ))}
        </Section>
      </SheetScreen>
    </Modal>
  );
}
