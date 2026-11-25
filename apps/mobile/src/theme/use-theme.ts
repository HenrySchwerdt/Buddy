import { useColorScheme } from 'react-native';
import { useSettings } from '@/runtime/settings-store';
import { darkTheme, lightTheme, type Theme } from './tokens';

export function useTheme(): Theme {
  const system = useColorScheme();
  const pref = useSettings((s) => s.appearance);
  const mode = pref === 'system' ? system : pref;
  return mode === 'light' ? lightTheme : darkTheme;
}
