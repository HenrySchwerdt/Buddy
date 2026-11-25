import { Image } from 'expo-image';
import { SymbolView } from 'expo-symbols';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useRef } from 'react';
import { AccessibilityInfo, Animated, Easing, Pressable, StyleSheet, View } from 'react-native';
import { CHAPTERS, CHAPTER_INFO, type Chapter } from '../model';
import { useOnboardingDraft } from '../store';
import { OB, OT, alpha } from '../theme';
import { Bullet, Card, Divider, NoticeBox, Stack, StepHeading, Headline } from '../ui';

const STARTUP_GUIDE_URL = 'https://triodocs.org/startup-guide';

/** Trio's `PulsingLogoAnimation` with Buddy's app icon. */
function PulsingLogo() {
  const intro = useRef(new Animated.Value(0)).current;
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    let stopped = false;
    void AccessibilityInfo.isReduceMotionEnabled().then((reduce) => {
      if (stopped) return;
      if (reduce) {
        Animated.timing(intro, { toValue: 1, duration: 1000, useNativeDriver: true }).start();
        return;
      }
      Animated.timing(intro, { toValue: 1, duration: 1000, easing: Easing.inOut(Easing.ease), useNativeDriver: true }).start();
      const loop = Animated.loop(Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 1000, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 1000, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]));
      loop.start();
      setTimeout(() => {
        loop.stop();
        Animated.timing(pulse, { toValue: 0, duration: 1000, easing: Easing.out(Easing.ease), useNativeDriver: true }).start();
      }, 3000);
    });
    return () => {
      stopped = true;
    };
  }, [intro, pulse]);
  const scale = Animated.multiply(intro.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1] }), pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.1] }));
  const rotate = intro.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  return (
    <Animated.View style={{ opacity: intro, transform: [{ scale }, { rotate }] }} importantForAccessibility="no-hide-descendants">
      <Image source={require('@/assets/images/icon.png')} style={styles.logo} contentFit="cover" />
    </Animated.View>
  );
}

export function WelcomeStep() {
  return (
    <View style={styles.welcome}>
      <PulsingLogo />
      <View style={{ height: 40 }} />
      <Stack style={{ padding: 16, alignSelf: 'stretch' }}>
        <OT style_="title2" weight="700" accessibilityRole="header">
          Hi there!
        </OT>
        <OT secondary>Welcome to Buddy — an automated insulin delivery system for iOS based on the OpenAPS algorithm with adaptations.</OT>
        <OT secondary>Buddy is designed to help manage your diabetes efficiently. To get the most out of the app, we'll guide you through setting up some essential parameters.</OT>
        <OT weight="700">Let's go through a few quick steps to ensure Buddy works optimally for you.</OT>
      </Stack>
    </View>
  );
}

/** Buddy-only step: medical-device disclaimer the user must acknowledge before continuing. */
export function DisclaimerStep() {
  const acknowledged = useOnboardingDraft((s) => s.acknowledged);
  const set = useOnboardingDraft((s) => s.set);
  return (
    <Stack>
      <StepHeading>Before you continue…</StepHeading>
      <NoticeBox>
        <OT>
          Buddy is <OT weight="700">not a medical device</OT>. It is experimental, open-source research software and is not cleared or approved by any regulator (FDA, EU MDR or otherwise).
        </OT>
      </NoticeBox>
      <Card style={{ gap: 10 }}>
        <Bullet text="Buddy is not intended to diagnose, treat, cure or prevent any disease." />
        <Bullet text="Do not use Buddy to make treatment decisions." />
        <Bullet text="Algorithm results and simulations do not predict how Buddy will behave for a real person." />
        <Bullet text="Anyone who builds, modifies or runs Buddy does so entirely at their own risk. The authors and contributors accept no liability whatsoever." />
      </Card>
      <Pressable
        onPress={() => set({ acknowledged: !acknowledged })}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: acknowledged }}
        style={({ pressed }) => [styles.ack, { borderColor: acknowledged ? OB.blue : 'transparent' }, pressed && { opacity: 0.7 }]}>
        <SymbolView name={acknowledged ? 'checkmark.square.fill' : 'square'} size={26} tintColor={acknowledged ? OB.blue : OB.secondary} />
        <OT style={{ flex: 1 }}>I understand that Buddy is not a medical device, and I use it entirely at my own risk.</OT>
      </Pressable>
    </Stack>
  );
}

export function StartupGuideStep() {
  return (
    <Stack>
      <StepHeading>Before you begin…</StepHeading>
      <Card style={{ gap: 16 }}>
        <View style={{ gap: 10 }}>
          <Bullet text="Take a deep breath — you've got this." />
          <Bullet text="There's no rush. Take all the time you need." />
          <Bullet text="Everything you enter here can be adjusted later in the app." />
          <Bullet text="Want a hand? You can open our full Startup Guide here:" />
        </View>
        <Pressable onPress={() => void WebBrowser.openBrowserAsync(STARTUP_GUIDE_URL)} accessibilityRole="link" style={({ pressed }) => [styles.link, pressed && { opacity: 0.6 }]}>
          <OT color={OB.blue}>{STARTUP_GUIDE_URL}</OT>
        </Pressable>
      </Card>
    </Stack>
  );
}

export function ForceCloseWarningStep() {
  return (
    <Stack>
      <StepHeading inset={false}>One last thing, before you begin...</StepHeading>
      <Card style={{ gap: 10 }}>
        <Bullet text="You can pause at any time. If you feel like taking a break, do it and put the phone down!" />
        <Bullet text="All entries you made during Onboarding will be saved automatically when you complete the wizard." />
      </Card>
      <NoticeBox>
        <OT>Just be aware: if you force quit the app before finishing onboarding, your progress will not be saved.</OT>
      </NoticeBox>
    </Stack>
  );
}

function StepCount({ n, color, textColor }: { n: number; color: string; textColor: string }) {
  return (
    <View style={[styles.count, { backgroundColor: color }]}>
      <OT style_="subheadline" weight="700" color={textColor}>
        {n}
      </OT>
    </View>
  );
}

export function OverviewStep() {
  return (
    <Stack>
      <Headline>Here is an overview of what to expect:</Headline>
      <Card style={{ gap: 12 }}>
        {CHAPTERS.map((ch, i) => (
          <View key={ch} style={{ gap: 12 }}>
            <View>
              <View style={styles.itemHeader}>
                <StepCount n={i + 1} color={OB.blue} textColor="#FFFFFF" />
                <OT style_="headline" style={{ flex: 1 }}>
                  {CHAPTER_INFO[ch].title}
                </OT>
                <OT style_="subheadline">{`${CHAPTER_INFO[ch].duration} min`}</OT>
              </View>
              <OT style_="footnote" secondary style={{ paddingVertical: 8 }}>
                {CHAPTER_INFO[ch].overview}
              </OT>
            </View>
            {i < CHAPTERS.length - 1 ? <Divider /> : null}
          </View>
        ))}
      </Card>
    </Stack>
  );
}

/** `CompletedStepView`: chapter completion (current chapter set) or the final "You're All Set!". */
export function CompletedStep({ chapter }: { chapter: Chapter | null }) {
  const done = chapter === null;
  const isCompleted = (ch: Chapter) => done || CHAPTERS.indexOf(ch) <= CHAPTERS.indexOf(chapter!);
  return (
    <View style={{ gap: 20, padding: 16, alignItems: 'center' }}>
      {done ? (
        <>
          <SymbolView name="checkmark.circle.fill" size={60} tintColor={OB.green} type="palette" colors={['#000000', OB.green]} />
          <OT style_="title" weight="700" align="center">
            You're All Set!
          </OT>
          <OT secondary align="center">
            You've successfully completed the initial setup of Buddy. Tap 'Get Started' to save your settings and start using Buddy.
          </OT>
        </>
      ) : null}
      <View style={[styles.completedCard, { alignSelf: 'stretch' }]}>
        {CHAPTERS.map((ch, i) => {
          const complete = isCompleted(ch);
          const description = complete ? CHAPTER_INFO[ch].completed : CHAPTER_INFO[ch].overview;
          return (
            <View key={ch} style={{ gap: 12 }} accessible accessibilityLabel={`${CHAPTER_INFO[ch].title}. ${description}`} accessibilityValue={{ text: complete ? 'complete' : 'not complete' }}>
              <View style={{ gap: 10 }}>
                <View style={styles.itemHeader}>
                  <StepCount n={i + 1} color={complete ? OB.green : OB.secondary} textColor={OB.bgBottom} />
                  <OT style_="headline" weight="700" style={{ flex: 1 }}>
                    {CHAPTER_INFO[ch].title}
                  </OT>
                  <SymbolView name={complete ? 'checkmark.circle.fill' : 'circle'} size={22} weight="bold" tintColor={complete ? OB.green : OB.secondary} type={complete ? 'palette' : 'monochrome'} colors={complete ? [OB.bgBottom, OB.green] : undefined} />
                </View>
                <OT style_="footnote" color="rgba(255,255,255,0.8)" style={{ paddingVertical: 8 }}>
                  {description}
                </OT>
              </View>
              {i < CHAPTERS.length - 1 ? <Divider /> : null}
            </View>
          );
        })}
      </View>
      {done ? (
        <OT weight="700" align="center">
          Remember, you can adjust these settings at any time in the app settings if needed.
        </OT>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  welcome: { alignItems: 'center', padding: 16, paddingTop: 140 },
  logo: { width: 100, height: 100, borderRadius: 50 },
  link: { alignSelf: 'center', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, backgroundColor: alpha('#0A84FF', 0.2) },
  ack: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16, borderRadius: 10, borderWidth: 2, backgroundColor: OB.card },
  count: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  itemHeader: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  completedCard: { gap: 12, padding: 16, borderRadius: 12, backgroundColor: alpha('#30D158', 0.1) },
});
