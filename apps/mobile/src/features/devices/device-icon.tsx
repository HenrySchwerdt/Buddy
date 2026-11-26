import { Image } from 'expo-image';
import { SymbolView } from '@/trio/symbol';
import { View } from 'react-native';
import { useTrioColors } from '@/trio';
import type { CatalogEntry, DeviceImage } from './catalog';

/**
 * Device artwork. Sources and licences (details in NOTICE):
 * - MIT, copied from the device kits Trio embeds: omnipod / omnipod-dash (OmnipodKit), medtrum-nano (MedtrumKit),
 *   dana (DanaKit), dexcom-g5 / dexcom-g6 (CGMBLEKit), dexcom-g7 (G7SensorKit), syai (SyaiKit),
 *   rileylink (RileyLinkKit), pump-simulator / cgm-simulator (LoopKit MockKitUI).
 * - Original drawings made for Buddy (SVG sources in images/src/): minimed, insight, eversense, accu-chek, libre,
 *   libre-3, dexcom-share, xdrip, nightscout. They show generic form factors only, no logos or traced photos.
 * MinimedKit, EversenseKit and AccuChekKit have no licence, so none of their artwork may be used here.
 */
export const DEVICE_IMAGES: Record<DeviceImage, number> = {
  omnipod: require('./images/omnipod.png'),
  'omnipod-dash': require('./images/omnipod-dash.png'),
  minimed: require('./images/minimed.png'),
  insight: require('./images/insight.png'),
  'medtrum-nano': require('./images/medtrum-nano.png'),
  dana: require('./images/dana.png'),
  rileylink: require('./images/rileylink.png'),
  'pump-simulator': require('./images/pump-simulator.png'),
  libre: require('./images/libre.png'),
  'libre-3': require('./images/libre-3.png'),
  'dexcom-g5': require('./images/dexcom-g5.png'),
  'dexcom-g6': require('./images/dexcom-g6.png'),
  'dexcom-g7': require('./images/dexcom-g7.png'),
  'dexcom-share': require('./images/dexcom-share.png'),
  'accu-chek': require('./images/accu-chek.png'),
  eversense: require('./images/eversense.png'),
  syai: require('./images/syai.png'),
  nightscout: require('./images/nightscout.png'),
  xdrip: require('./images/xdrip.png'),
  'cgm-simulator': require('./images/cgm-simulator.png'),
};

/** `DeviceIconLayout`: 44 pt tile, radius 10, 5 pt image inset, 19 pt fallback glyph. */
const TILE = 44;

export function DeviceIcon({ entry, size = TILE, background }: { entry: CatalogEntry; size?: number; background?: string }) {
  const c = useTrioColors();
  const inset = (5 * size) / TILE;
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: (10 * size) / TILE,
        borderCurve: 'continuous',
        backgroundColor: background ?? (c.dark ? 'rgba(118,118,128,0.24)' : 'rgba(118,118,128,0.12)'),
        alignItems: 'center',
        justifyContent: 'center',
      }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants">
      {entry.image ? (
        <Image
          source={DEVICE_IMAGES[entry.image]}
          contentFit="contain"
          tintColor={entry.templateImage ? c.tabBar : undefined}
          style={{ width: size - 2 * inset, height: size - 2 * inset }}
        />
      ) : (
        <SymbolView name={entry.kind === 'pump' ? 'ivfluid.bag' : 'sensor.tag.radiowaves.forward'} size={(19 * size) / TILE} tintColor={c.tabBar} />
      )}
    </View>
  );
}
