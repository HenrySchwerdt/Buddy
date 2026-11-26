import { SymbolView as ExpoSymbolView, type SFSymbol, type SymbolViewProps } from 'expo-symbols';

import { androidSymbolFor } from './symbol-map';

type AndroidSymbol = Extract<SymbolViewProps['name'], { android?: unknown }>['android'] & string;

export type { SFSymbol };

/** Drop-in for expo-symbols' SymbolView that also renders on Android. */
export function SymbolView({ name, ...rest }: Omit<SymbolViewProps, 'name'> & { name: SFSymbol | SymbolViewProps['name'] }) {
  const resolved = typeof name === 'string' ? { ios: name, android: androidSymbolFor(name) as AndroidSymbol } : name;
  return <ExpoSymbolView name={resolved} {...rest} />;
}
