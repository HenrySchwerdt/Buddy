import { StatusBar } from 'expo-status-bar';
import { OnboardingRoot } from '@/features/onboarding/root';

/** Trio's onboarding wizard (forced dark appearance, like Trio). */
export default function Onboarding() {
  return (
    <>
      <StatusBar style="light" />
      <OnboardingRoot />
    </>
  );
}
