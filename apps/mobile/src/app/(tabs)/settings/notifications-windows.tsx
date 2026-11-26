import type { AlertSettings } from '@buddy/core';
import { formatMinuteOfDay, TimeOfDayRow } from '@/features/settings-b/time-row';
import { HintParagraphs, HintSheet, INDIGO, MiniHint, useHint } from '@/features/settings-b/ui';
import { now } from '@/runtime/runtime';
import { useSettings } from '@/runtime/settings-store';
import { Section, TrioScreen, useTrioColors } from '@/trio';
import { View } from 'react-native';

const DAY_DEFAULT = 6 * 60;
const NIGHT_DEFAULT = 22 * 60;

/**
 * Trio AlarmWindows.RootView. The window boundaries live in AlertSettings.quietHours:
 * Night = quietHours start ("Night Starts") → end ("Day Starts"). Each glucose alarm picks Day,
 * Night or Day & Night itself; the alarm sync (features/settings-b/alarm-store) applies them.
 */
export default function AlarmWindowsScreen() {
  const c = useTrioColors();
  const alerts = useSettings((s) => s.alerts);
  const update = useSettings((s) => s.update);
  const help = useHint();
  const quiet = alerts.quietHours;

  const setQuiet = (patch: Partial<AlertSettings['quietHours']>) => {
    // Store the device's current UTC offset so the window follows local time.
    const utcOffsetMinutes = -new Date(now()).getTimezoneOffset();
    update({ alerts: { ...alerts, quietHours: { ...quiet, ...patch, utcOffsetMinutes } } });
  };

  const showHelp = () => {
    const day = formatMinuteOfDay(DAY_DEFAULT);
    const night = formatMinuteOfDay(NIGHT_DEFAULT);
    help.show({
      label: 'Day and Night Window',
      body: (
        <HintParagraphs
          boldFirst
          lines={[
            `Default: Day starts ${day}, Night starts ${night}.`,
            'These two times define the Day and Night windows. Each glucose alarm’s Active setting picks one — Day & Night, Day only, or Night only — and only fires when that window is current.',
            `The Night window runs from 'Night Starts' back around to 'Day Starts' — so by default, Night covers ${night} through ${day} the next morning.`,
                      ]}
        />
      ),
    });
  };

  return (
    <TrioScreen back inlineTitle="Day & Night Windows">
      <Section header="Window Boundaries">
        <View style={{ paddingTop: 8 }}>
          <TimeOfDayRow label="Day Starts" icon="sun.max.fill" iconColor={c.orange} minute={quiet.endMinute} onChange={(m) => setQuiet({ endMinute: m })} />
          <TimeOfDayRow label="Night Starts" icon="moon.stars.fill" iconColor={c.dark ? INDIGO.dark : INDIGO.light} minute={quiet.startMinute} onChange={(m) => setQuiet({ startMinute: m })} />
          <View style={{ paddingHorizontal: 20, paddingBottom: 4 }}>
            <MiniHint text="Decides when each alarm's Day or Night setting applies." label="Day and Night Window" onHelp={showHelp} />
          </View>
        </View>
      </Section>

      <HintSheet hint={help.hint} onClose={help.close} />
    </TrioScreen>
  );
}
