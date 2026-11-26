import { useEffect, useState } from 'react';
import { keychainSecretStore } from '@/runtime/transports/secret-store';
import { Row, Section, T, ValueRow } from '@/trio';
import { formatCrc, loadStoredCalibrations, type StoredCalibration } from './stored';

const num = (v: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(v);

/** Info sections of the Libre calibrations screen (Slope / Intercept in Trio map to extra slope / offset). */
export function CalibrationSections() {
  const [items, setItems] = useState<StoredCalibration[] | null>(null);
  useEffect(() => {
    let live = true;
    void loadStoredCalibrations((k) => keychainSecretStore.get(k)).then((r) => live && setItems(r));
    return () => {
      live = false;
    };
  }, []);
  if (!items) return null;
  const any = items.some((i) => i.info);
  return (
    <>
      {items.map(({ label, info }) => (
        <Section key={label} header={label} footer={info ? undefined : 'No calibration stored for this sensor type.'}>
          {info ? (
            <>
              <ValueRow label="Slope" value={num(info.extraSlope)} />
              <ValueRow label="Intercept" value={num(info.extraOffset)} />
              {([['i1', info.i1], ['i2', info.i2], ['i3', info.i3], ['i4', info.i4], ['i5', info.i5], ['i6', info.i6]] as const).map(([k, v]) => (
                <ValueRow key={k} label={k} value={num(v)} />
              ))}
              <ValueRow label="Footer CRC" value={formatCrc(info.isValidForFooterWithReverseCRCs)} />
            </>
          ) : (
            <Row>
              <T secondary>Not available</T>
            </Row>
          )}
        </Section>
      ))}
      <T style_="footnote" secondary style={{ marginHorizontal: 20 }}>
        {any ? 'Factory calibration read from the sensor. Buddy applies it automatically and does not support manual meter calibration.' : 'Pair a Libre sensor first. Buddy reads the factory calibration from the sensor and does not support manual meter calibration.'}
      </T>
    </>
  );
}
