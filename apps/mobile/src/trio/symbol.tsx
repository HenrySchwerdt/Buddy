import { SymbolView as ExpoSymbolView, type SFSymbol, type SymbolViewProps } from 'expo-symbols';

import { Platform } from 'react-native';
import { ANDROID_SIZE, androidSymbolFor } from './symbol-map';

type AndroidSymbol = Extract<SymbolViewProps['name'], { android?: unknown }>['android'] & string;

export type { SFSymbol };

/** Drop-in for expo-symbols' SymbolView that also renders on Android. */
export function SymbolView({ name, ...rest }: Omit<SymbolViewProps, 'name'> & { name: SFSymbol | SymbolViewProps['name'] }) {
  const resolved = typeof name === 'string' ? { ios: name, android: androidSymbolFor(name) as AndroidSymbol } : name;
  const size = Platform.OS === 'android' && typeof name === 'string' && ANDROID_SIZE[name] ? ANDROID_SIZE[name] : rest.size;
  return <ExpoSymbolView name={resolved} {...rest} size={size} />;
}
