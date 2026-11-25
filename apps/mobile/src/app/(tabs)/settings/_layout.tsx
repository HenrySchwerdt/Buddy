import { Stack } from 'expo-router';

/** Settings NavigationStack. Screens draw their own Trio toolbar (TrioScreen `back`). */
export default function SettingsLayout() {
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: 'transparent' } }} />;
}
