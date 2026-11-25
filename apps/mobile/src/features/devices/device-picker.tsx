import { SymbolView } from '@/trio/symbol';
import { View } from 'react-native';
import { CapsuleButton, Row, Section, SheetScreen, T, useTrioColors } from '@/trio';
import { catalogFor, catalogSections, isSupported, modelsLine, NOT_SUPPORTED, type CatalogEntry, type DeviceKind } from './catalog';
import { DeviceIcon } from './device-icon';

/** Port of `DevicePickerView`: sheet listing devices grouped by manufacturer. */
export function DevicePicker({ kind, onSelect, onCancel }: { kind: DeviceKind; onSelect: (e: CatalogEntry) => void; onCancel: () => void }) {
  const sections = catalogSections(catalogFor(kind), __DEV__);
  return (
    <SheetScreen title={kind === 'pump' ? 'Add Pump' : 'Add CGM'} leading={<CapsuleButton label="Cancel" onPress={onCancel} />}>
      {sections.map((s) => (
        <Section key={s.manufacturer} header={s.manufacturer}>
          {s.entries.map((e) => (
            <DevicePickerRow key={e.id} entry={e} onPress={() => onSelect(e)} />
          ))}
        </Section>
      ))}
    </SheetScreen>
  );
}

function DevicePickerRow({ entry, onPress }: { entry: CatalogEntry; onPress: () => void }) {
  const c = useTrioColors();
  const supported = isSupported(entry);
  const sub = supported ? modelsLine(entry) : NOT_SUPPORTED;
  return (
    <Row onPress={supported ? onPress : undefined} accessibilityLabel={`${entry.name}${sub ? `, ${sub}` : ''}`} style={{ paddingVertical: 16 }}>
      <View style={{ opacity: supported ? 1 : 0.45 }}>
        <DeviceIcon entry={entry} />
      </View>
      <View style={{ flex: 1, gap: 2, opacity: supported ? 1 : 0.45 }}>
        <T style_="headline">{entry.name}</T>
        {sub ? (
          <T style_="callout" secondary>
            {sub}
          </T>
        ) : null}
      </View>
      {supported ? <SymbolView name="chevron.right" size={13} tintColor={c.tertiary} weight="semibold" /> : null}
    </Row>
  );
}
