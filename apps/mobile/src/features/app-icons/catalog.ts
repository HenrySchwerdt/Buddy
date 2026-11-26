import type { ImageSourcePropType } from 'react-native';

/** Buddy's app icons. `name` is the alternate icon name registered in app.json (null = the default icon). */
export interface AppIconOption {
  readonly name: 'Midnight' | 'Daylight' | 'Ember' | null;
  readonly label: string;
  readonly preview: ImageSourcePropType;
}

export const APP_ICONS: readonly AppIconOption[] = [
  { name: null, label: 'Buddy', preview: require('@/assets/images/icon.png') },
  { name: 'Midnight', label: 'Midnight', preview: require('@/assets/icons/buddy-midnight.png') },
  { name: 'Daylight', label: 'Daylight', preview: require('@/assets/icons/buddy-daylight.png') },
  { name: 'Ember', label: 'Ember', preview: require('@/assets/icons/buddy-ember.png') },
];

/** The option for a reported icon name; unknown names fall back to the default icon. */
export function selectedIcon(active: string | null | undefined): AppIconOption {
  return APP_ICONS.find((i) => i.name === active) ?? APP_ICONS[0]!;
}
