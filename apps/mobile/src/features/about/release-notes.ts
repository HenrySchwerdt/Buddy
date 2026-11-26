/** What changed per Buddy release. Bundled with the app: Buddy never fetches release notes. */
export interface ReleaseNotes {
  readonly version: string;
  /** ISO date. */
  readonly date: string;
  readonly highlights: readonly string[];
}

/** Newest first. */
export const RELEASE_NOTES: readonly ReleaseNotes[] = [
  {
    version: '0.1.0',
    date: '2026-11-26',
    highlights: [
      'First public build of Buddy, a React Native port of Trio.',
      'Closed loop with any supported pump and CGM, gated by the same safety checks as Trio.',
      'Pump drivers include Omnipod DASH and Eros (via RileyLink). CGM sources include Dexcom G6 and G7, Libre 2, Libre 3 and LibreLinkUp, and Syai.',
      'oref SMB algorithm from Trio with forecasts, Dynamic ISF, Autosens and temp targets.',
      'Statistics with glucose, insulin, looping and meal charts, and a PDF report you share yourself.',
      'History with deletion of insulin, carbs and glucose entries.',
      'External insulin and carb notes.',
      'Glucose and device alarms with day and night windows.',
      'Report a Problem builds a report on your device. Nothing is sent unless you send it.',
    ],
  },
];

const dateFormat = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

export const formatReleaseDate = (iso: string): string => dateFormat.format(new Date(`${iso}T12:00:00Z`));

/** The entry for the running version, if the changelog has one. */
export const notesFor = (version: string): ReleaseNotes | undefined => RELEASE_NOTES.find((r) => r.version === version);

/** Releases other than the running one, newest first. */
export const previousReleases = (version: string): readonly ReleaseNotes[] => RELEASE_NOTES.filter((r) => r.version !== version);
