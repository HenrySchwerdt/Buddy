import { useEffect, useState } from 'react';
import { Linking } from 'react-native';
import { listCalendars, requestCalendarAccess, type CalendarChoice } from '@/runtime/calendar';
import { HintParagraphs, HintSheet, ToggleWithHint, useHint } from '@/features/settings-b/ui';
import { useSettings } from '@/runtime/settings-store';
import { PickerRow, Row, Section, T, TrioScreen, useTrioColors } from '@/trio';

/** Trio Modules/CalendarEventSettings (CalendarEventSettings.RootView). */
export default function CalendarEventsScreen() {
  const c = useTrioColors();
  const help = useHint();
  const s = useSettings();
  const [calendars, setCalendars] = useState<CalendarChoice[]>([]);
  const [denied, setDenied] = useState(false);

  useEffect(() => {
    if (!s.useCalendar) return;
    let alive = true;
    void (async () => {
      const granted = await requestCalendarAccess();
      if (!alive) return;
      setDenied(!granted);
      if (granted) setCalendars(await listCalendars().catch(() => []));
    })();
    return () => {
      alive = false;
    };
  }, [s.useCalendar]);

  const chosen = calendars.find((x) => x.title === s.calendarTitle)?.title ?? calendars[0]?.title ?? '';

  return (
    <TrioScreen back title="Calendar Events">
      <Section header="Diabetes Data as Calendar Event">
        <ToggleWithHint
          label="Create Events in Calendar"
          value={s.useCalendar}
          onChange={(v) => s.update({ useCalendar: v })}
          miniHint="Use calendar events to display current data."
          onHelp={() =>
            help.show({
              label: 'Create Events in Calendar',
              body: (
                <HintParagraphs
                  boldFirst
                  lines={[
                    'Default: OFF',
                    'When enabled, Buddy will create a customizable calendar event to keep you notified of your current glucose reading with every successful loop cycle.',
                    'This is useful if you use CarPlay or a variety of other external services that limit the view of most apps, but allow the calendar app.',
                    'Note: Once a new calendar event is created, the previous event will be deleted.',
                  ]}
                />
              ),
            })
          }
        />
      </Section>

      {s.useCalendar && calendars.length > 0 ? (
        <>
          <Section>
            <PickerRow label="Choose Calendar" value={chosen} options={calendars.map((x) => ({ value: x.title, label: x.title }))} onChange={(v) => s.update({ calendarTitle: v })} />
          </Section>
          <Section>
            <ToggleWithHint
              label="Display Emojis as Labels"
              value={s.displayCalendarEmojis}
              onChange={(v) => s.update({ displayCalendarEmojis: v })}
              miniHint="Use emojis for calendar events. See hint for more details."
              onHelp={() =>
                help.show({
                  label: 'Display Emojis as Labels',
                  body: (
                    <HintParagraphs
                      boldFirst
                      lines={['Default: OFF', 'The event shows whether glucose is in range with colour emojis:\n🟢 In range\n🟠 Above range\n🔴 Below range\n🚫 Loop is not running', 'With "Display IOB and COB", the labels IOB and COB become 💉 and 🥨.']}
                    />
                  ),
                })
              }
            />
          </Section>
          <Section>
            <ToggleWithHint
              label="Display IOB and COB"
              value={s.displayCalendarIOBandCOB}
              onChange={(v) => s.update({ displayCalendarIOBandCOB: v })}
              miniHint="Include IOB & COB in the calendar event data."
              onHelp={() => help.show({ label: 'Display IOB and COB', body: <HintParagraphs boldFirst lines={['Default: OFF', 'When enabled, Buddy will include the current IOB and COB values, along with the current glucose reading, in each calendar event created.']} /> })}
            />
          </Section>
        </>
      ) : s.useCalendar ? (
        <Section>
          <Row>
            <T color={c.secondary} style_="footnote" style={{ flex: 1 }}>
              {denied ? 'Buddy has no access to your calendars. Open Settings and allow Full Access to Calendars.' : 'No calendar that accepts new events was found.'}
            </T>
          </Row>
          {denied ? (
            <Row onPress={() => void Linking.openSettings()}>
              <T color={c.tabBar}>Open Settings</T>
            </Row>
          ) : null}
        </Section>
      ) : null}
      <HintSheet hint={help.hint} onClose={help.close} />
    </TrioScreen>
  );
}
