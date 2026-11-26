import '@/runtime/crypto-polyfill';
import { Nunito_600SemiBold, Nunito_700Bold, Nunito_800ExtraBold, Nunito_900Black, useFonts } from '@expo-google-fonts/nunito';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { Platform, StatusBar as RNStatusBar } from 'react-native';
import { useSettings } from '@/runtime/settings-store';
import { startRuntime } from '@/runtime/runtime';
import { useTheme } from '@/theme/use-theme';
import { ChoiceDialogHost } from '@/trio/choice-dialog';
import { useTrioColors } from '@/trio';

void SplashScreen.preventAutoHideAsync();

function useHydrated() {
  const [hydrated, setHydrated] = useState(useSettings.persist.hasHydrated());
  useEffect(() => useSettings.persist.onFinishHydration(() => setHydrated(true)), []);
  return hydrated;
}

export default function RootLayout() {
  const theme = useTheme();
  const trio = useTrioColors();
  const hydrated = useHydrated();
  const [fontsLoaded] = useFonts({ Nunito_600SemiBold, Nunito_700Bold, Nunito_800ExtraBold, Nunito_900Black });
  const onboarded = useSettings((s) => s.onboarded);

  useEffect(() => {
    if (!hydrated || !fontsLoaded) return;
    void SplashScreen.hideAsync();
    if (onboarded) void startRuntime();
  }, [hydrated, fontsLoaded, onboarded]);

  if (!hydrated || !fontsLoaded) return null;
  const nav = theme.dark ? DarkTheme : DefaultTheme;
  // Android has no page sheets: they open full screen, so the content starts below the status bar.
  const sheet = { presentation: 'pageSheet' as const, headerShown: false, contentStyle: { backgroundColor: Platform.OS === 'android' ? trio.bgBottom : theme.bgBottom, paddingTop: Platform.OS === 'android' ? (RNStatusBar.currentHeight ?? 0) : 0 } };

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
    <ThemeProvider value={{ ...nav, colors: { ...nav.colors, background: theme.bgBottom, primary: theme.accent } }}>
      <StatusBar style={theme.dark ? 'light' : 'dark'} />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Protected guard={onboarded}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="treatment" options={sheet} />
          <Stack.Screen name="bolus-details" options={sheet} />
          <Stack.Screen name="treatment-presets" options={sheet} />
          <Stack.Screen name="loop" options={{ ...sheet, presentation: 'formSheet', sheetGrabberVisible: true, sheetAllowedDetents: 'fitToContents' }} />
          <Stack.Screen name="legend" options={sheet} />
          <Stack.Screen name="statistics" options={sheet} />
          <Stack.Screen name="add-glucose" options={{ ...sheet, presentation: 'formSheet', sheetGrabberVisible: true, sheetAllowedDetents: 'fitToContents' }} />
          <Stack.Screen name="override-editor" options={sheet} />
          <Stack.Screen name="temp-target-editor" options={sheet} />
          <Stack.Screen name="add-pump" options={sheet} />
          <Stack.Screen name="add-cgm" options={sheet} />
          <Stack.Screen name="pump-settings" options={sheet} />
          <Stack.Screen name="cgm-settings" options={sheet} />
        </Stack.Protected>
        <Stack.Protected guard={!onboarded}>
          <Stack.Screen name="onboarding" />
        </Stack.Protected>
      </Stack>
      <ChoiceDialogHost />
    </ThemeProvider>
    </GestureHandlerRootView>
  );
}
