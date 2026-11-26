import { useEffect, useRef, useState } from 'react';
import { Modal, Pressable } from 'react-native';
import { CapsuleButton, Row, Section, SheetScreen, T, useTrioColors } from '@/trio';
import { SymbolView } from '@/trio/symbol';
import { ALARM_SOUNDS, TonePreview } from './alarm-sounds';

/** TonePickerSheet: choose a tone, with a play / stop preview button per row. */
export function TonePickerSheet({ visible, selected, onSelect, onClose }: { visible: boolean; selected: string; onSelect: (id: string) => void; onClose: () => void }) {
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      {visible ? <Picker selected={selected} onSelect={onSelect} onClose={onClose} /> : null}
    </Modal>
  );
}

function Picker({ selected, onSelect, onClose }: { selected: string; onSelect: (id: string) => void; onClose: () => void }) {
  const c = useTrioColors();
  const [playing, setPlaying] = useState<string | null>(null);
  const preview = useRef<TonePreview | null>(null);
  if (!preview.current) preview.current = new TonePreview(setPlaying);
  useEffect(() => () => preview.current?.stop(), []);
  const close = () => {
    preview.current?.stop();
    onClose();
  };
  return (
    <SheetScreen title="Choose Tone" trailing={<CapsuleButton label="Done" onPress={close} />}>
      <Section>
        {ALARM_SOUNDS.map((s) => {
          const on = s.id === selected;
          const isPlaying = playing === s.id;
          return (
            <Row
              key={s.id}
              accessibilityLabel={`${s.name}${on ? ', selected' : ''}`}
              onPress={() => {
                onSelect(s.id);
                preview.current?.play(s.id);
              }}>
              <SymbolView name={on ? 'checkmark.circle.fill' : 'circle'} size={22} tintColor={c.tabBar} />
              <T style={{ flex: 1 }}>{s.name}</T>
              <Pressable onPress={() => preview.current?.toggle(s.id)} hitSlop={10} accessibilityRole="button" accessibilityLabel={isPlaying ? 'Stop preview' : 'Play preview'}>
                <SymbolView name={isPlaying ? 'stop.circle.fill' : 'play.circle.fill'} size={26} tintColor={c.tabBar} />
              </Pressable>
            </Row>
          );
        })}
      </Section>
    </SheetScreen>
  );
}
