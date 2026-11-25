import { router, type Href } from 'expo-router';
import type { PropsWithChildren, ReactNode } from 'react';
import { TrioScreen } from '@/trio';
import { HintSheetProvider } from './hint-sheet';

/** Pushed settings screen: back capsule, large title, Help sheet host. */
export function SettingsScreen({ title, trailing, children }: PropsWithChildren<{ title: string; trailing?: ReactNode }>) {
  return (
    <HintSheetProvider>
      <TrioScreen title={title} back trailing={trailing}>
        {children}
      </TrioScreen>
    </HintSheetProvider>
  );
}

/** Pushes a settings route. Routes owned by other agents may not exist in the typed-route table yet. */
export const go = (path: string, params?: Record<string, string>) => router.push((params ? { pathname: path, params } : path) as Href);
