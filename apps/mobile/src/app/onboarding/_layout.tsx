import { Stack } from 'expo-router';
import { TRIO_DARK } from '@/trio';

/** Onboarding stack. Trio's onboarding is a single root view that swaps its step content, so it has one screen. */
export default function OnboardingLayout() {
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: TRIO_DARK.bgBottom } }} />;
}
