import { LinearGradient } from 'expo-linear-gradient';
import { SymbolView, type SFSymbol } from '@/trio/symbol';
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Alert, Pressable, ScrollView, StyleSheet, View, type ScrollViewInstance } from 'react-native';
import Animated, { FadeIn, SlideInLeft, SlideInRight } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { finishOnboarding, requestBluetooth, requestNotifications } from './actions';
import {
  ALGORITHM_OVERVIEW_SUBSTEPS,
  CHAPTER_INFO,
  CHAPTERS,
  DELIVERY_SUBSTEPS,
  INITIAL_NAV,
  NIGHTSCOUT_SUBSTEPS,
  PROGRESS_STEPS,
  SMB_SUBSTEPS,
  STARTUP_SUBSTEPS,
  STEP_INFO,
  TARGET_BEHAVIOR_SUBSTEPS,
  autosensSubsteps,
  backNav,
  chapterOf,
  nextNav,
  segmentFill,
  type NavContext,
  type NavState,
} from './model';
import { pumpModel, scheduleStepIncomplete } from './logic';
import { importFromNightscout } from './nightscout';
import { useOnboardingDraft, useOnboardingPrefs } from './store';
import { ACCENT, OB, OT, alpha } from './theme';
import { CompletedStep, DisclaimerStep, ForceCloseWarningStep, OverviewStep, StartupGuideStep, WelcomeStep } from './steps/intro';
import { AlgorithmContentsStep, AlgorithmImportantNotesStep, AlgorithmSubstepStep, DeliveryLimitsStep } from './steps/limits';
import { NightscoutImportStep, NightscoutLoginStep, NightscoutSetupStep, NightscoutUploadGlucoseStep, NightscoutUploadStep } from './steps/nightscout';
import { BluetoothPermissionStep, NotificationPermissionStep } from './steps/permissions';
import { BasalProfileStep, CarbRatioStep, GlucoseTargetStep, InsulinSensitivityStep, UnitSelectionStep } from './steps/therapy';
import { SYSTEM_SETTINGS } from '@/features/platform-copy';

const CAPSULE = 15 * 1.3;

function useNavContext(): NavContext {
  const nightscoutSetup = useOnboardingDraft((s) => s.nightscout.setup);
  const enableSMBAlways = useOnboardingDraft((s) => s.enableSMBAlways);
  const reportsRewindEvents = useOnboardingDraft((s) => pumpModel(s.pumpModelId).reportsRewindEvents);
  return { nightscoutSetup, enableSMBAlways, reportsRewindEvents };
}

function ProgressBar({ nav, ctx }: { nav: NavState; ctx: NavContext }) {
  const chapter = chapterOf(nav.step) ?? 'prepare';
  const showChapter = nav.chapterCompletion === null && nav.step !== 'overview' && nav.step !== 'completed';
  return (
    <View style={styles.progress} accessible accessibilityLabel={`Chapter ${CHAPTERS.indexOf(chapter) + 1} of ${CHAPTERS.length}, ${CHAPTER_INFO[chapter].title}`}>
      {showChapter ? (
        <View style={styles.chapterRow}>
          <View style={styles.chapterCapsule}>
            <OT style_="subheadline" weight="900" color={OB.bgTop}>
              {CHAPTERS.indexOf(chapter) + 1}
            </OT>
          </View>
          <OT style_="subheadline" weight="700" secondary style={{ letterSpacing: CAPSULE / 4, textTransform: 'uppercase' }}>
            {CHAPTER_INFO[chapter].title}
          </OT>
        </View>
      ) : null}
      <View style={styles.segments}>
        {PROGRESS_STEPS.map((s) => {
          const fill = segmentFill(s, nav, ctx);
          return (
            <View key={s} style={styles.segment}>
              <View style={[styles.segmentFill, { width: `${fill * 100}%` }]} />
            </View>
          );
        })}
      </View>
    </View>
  );
}

function StepHeader({ nav }: { nav: NavState }) {
  const info = STEP_INFO[nav.step];
  const accent = ACCENT[info.accent];
  return (
    <View style={styles.header} accessible accessibilityRole="header">
      <View style={[styles.headerIcon, { backgroundColor: alpha(accent, 0.2) }]}>
        <SymbolView name={info.icon as SFSymbol} size={40} tintColor={accent} />
      </View>
      <View style={{ flex: 1 }}>
        <OT style_="title" weight="700">
          {info.title}
        </OT>
        <OT style_="subheadline" secondary>
          {info.description}
        </OT>
      </View>
    </View>
  );
}

function StepContent({ nav, ctx }: { nav: NavState; ctx: NavContext }) {
  if (nav.chapterCompletion) return <CompletedStep chapter={nav.chapterCompletion} />;
  switch (nav.step) {
    case 'welcome':
      return <WelcomeStep />;
    case 'disclaimer':
      return <DisclaimerStep />;
    case 'startupInfo':
      return STARTUP_SUBSTEPS[nav.startup] === 'forceCloseWarning' ? <ForceCloseWarningStep /> : <StartupGuideStep />;
    case 'overview':
      return <OverviewStep />;
    case 'nightscout':
      switch (NIGHTSCOUT_SUBSTEPS[nav.nightscout]) {
        case 'connectToNightscout':
          return <NightscoutLoginStep />;
        case 'uploadToNightscout':
          return <NightscoutUploadStep />;
        case 'uploadGlucoseToNightscout':
          return <NightscoutUploadGlucoseStep />;
        case 'importFromNightscout':
          return <NightscoutImportStep />;
        default:
          return <NightscoutSetupStep />;
      }
    case 'unitSelection':
      return <UnitSelectionStep />;
    case 'glucoseTarget':
      return <GlucoseTargetStep />;
    case 'basalRates':
      return <BasalProfileStep />;
    case 'carbRatio':
      return <CarbRatioStep />;
    case 'insulinSensitivity':
      return <InsulinSensitivityStep />;
    case 'deliveryLimits':
      return <DeliveryLimitsStep substep={DELIVERY_SUBSTEPS[nav.delivery]!} />;
    case 'algorithmSettings':
      return ALGORITHM_OVERVIEW_SUBSTEPS[nav.algorithmOverview] === 'importantNotes' ? <AlgorithmImportantNotesStep /> : <AlgorithmContentsStep />;
    case 'autosensSettings':
      return <AlgorithmSubstepStep substep={autosensSubsteps(ctx.reportsRewindEvents)[nav.autosens] ?? 'autosensMin'} />;
    case 'smbSettings':
      return <AlgorithmSubstepStep substep={SMB_SUBSTEPS[nav.smb]!} />;
    case 'targetBehavior':
      return <AlgorithmSubstepStep substep={TARGET_BEHAVIOR_SUBSTEPS[nav.targetBehavior]!} />;
    case 'notifications':
      return <NotificationPermissionStep />;
    case 'bluetooth':
      return <BluetoothPermissionStep />;
    case 'completed':
      return <CompletedStep chapter={null} />;
  }
}

function useNextDisabled(nav: NavState): boolean {
  const ns = useOnboardingDraft((s) => s.nightscout);
  const acknowledged = useOnboardingDraft((s) => s.acknowledged);
  const draft = useOnboardingDraft();
  if (nav.chapterCompletion) return false;
  if (nav.step === 'disclaimer') return !acknowledged;
  if (scheduleStepIncomplete(nav.step, draft)) return true;
  if (nav.step !== 'nightscout') return false;
  const sub = NIGHTSCOUT_SUBSTEPS[nav.nightscout];
  return (sub === 'setupSelection' && ns.setup === null) || (sub === 'connectToNightscout' && !ns.connected) || (sub === 'importFromNightscout' && (ns.importOption === null || ns.importStatus === 'running'));
}

/** Async side effects of "Next" (`handleNextNavigation` cases with permission prompts / import / save). */
async function runNext(nav: NavState, ctx: NavContext, go: (n: NavState) => void) {
  const advance = () => go(nextNav(nav, ctx));
  if (nav.chapterCompletion) return advance();
  if (nav.step === 'nightscout' && NIGHTSCOUT_SUBSTEPS[nav.nightscout] === 'importFromNightscout' && useOnboardingDraft.getState().nightscout.importOption === 'import') {
    try {
      await importFromNightscout();
      advance();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      Alert.alert('Import Failed', `${message}\n\nTry again in a moment, or configure your Therapy Settings manually instead.`, [{ text: 'OK' }], { userInterfaceStyle: 'dark' });
    }
    return;
  }
  if (nav.step === 'notifications') {
    if ((await requestNotifications()) === 'granted') return advance();
    Alert.alert(
      'Notifications for “Buddy” are Disabled',
      `After completing onboarding, you can enable notifications for Buddy in the ${SYSTEM_SETTINGS} app.`,
      [
        { text: 'Cancel', style: 'cancel', onPress: advance },
        { text: 'Got it!', onPress: advance },
      ],
    );
    return;
  }
  if (nav.step === 'bluetooth') {
    if (useOnboardingPrefs.getState().bluetoothGranted) return advance();
    const answer = async (allow: boolean) => {
      // Like Trio, both answers ask the system so Buddy appears under Settings → Privacy → Bluetooth.
      const granted = await requestBluetooth();
      useOnboardingPrefs.getState().update({ bluetoothGranted: allow && granted });
      advance();
    };
    Alert.alert('“Buddy” Would Like to Use Bluetooth', 'Bluetooth is used to communicate with insulin pump and continuous glucose monitor devices.', [
      { text: 'Don’t Allow', style: 'cancel', onPress: () => void answer(false) },
      { text: 'Allow', onPress: () => void answer(true) },
    ]);
    return;
  }
  if (nav.step === 'completed') return finishOnboarding();
  advance();
}

export function OnboardingRoot() {
  const insets = useSafeAreaInsets();
  const ctx = useNavContext();
  const [nav, setNav] = useState<NavState>(INITIAL_NAV);
  const [direction, setDirection] = useState<'forward' | 'backward'>('forward');
  const [reduceMotion, setReduceMotion] = useState(false);
  const scroll = useRef<ScrollViewInstance>(null);
  const disabled = useNextDisabled(nav);

  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion);
  }, []);
  useEffect(() => {
    scroll.current?.scrollTo({ y: 0, animated: false });
  }, [nav]);

  const go = (next: NavState) => setNav(next);
  const onNext = () => {
    setDirection('forward');
    void runNext(nav, ctx, go);
  };
  const onBack = () => {
    setDirection('backward');
    setNav(backNav(nav, ctx));
  };

  const showProgress = (PROGRESS_STEPS.includes(nav.step) || nav.step === 'overview' || nav.step === 'completed');
  const showHeader = nav.step !== 'welcome' && nav.step !== 'completed' && nav.chapterCompletion === null;
  const contentKey = JSON.stringify(nav);
  const entering = reduceMotion ? FadeIn.duration(250) : direction === 'forward' ? SlideInRight.duration(300) : SlideInLeft.duration(300);

  return (
    <View style={{ flex: 1, backgroundColor: OB.bgBottom }}>
      <LinearGradient colors={[OB.bgTop, OB.bgBottom]} style={StyleSheet.absoluteFill} />
      <View style={{ paddingTop: insets.top, flex: 1 }}>
        {showProgress ? <ProgressBar nav={nav} ctx={ctx} /> : null}
        <ScrollView ref={scroll} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 80, gap: 20 }} showsVerticalScrollIndicator>
          {showHeader ? <StepHeader nav={nav} /> : null}
          <Animated.View key={contentKey} entering={entering} style={{ paddingHorizontal: 16 }}>
            <StepContent nav={nav} ctx={ctx} />
          </Animated.View>
        </ScrollView>
        <View style={[styles.footer, { paddingBottom: insets.bottom + 16 }]}>
          {nav.step !== 'welcome' ? (
            <Pressable onPress={onBack} accessibilityRole="button" accessibilityLabel="Back" style={({ pressed }) => [styles.back, pressed && { opacity: 0.5 }]}>
              <SymbolView name="chevron.left" size={17} tintColor={OB.primary} weight="medium" />
              <OT>Back</OT>
            </Pressable>
          ) : null}
          <View style={{ flex: 1 }} />
          <Pressable
            onPress={onNext}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityState={{ disabled }}
            style={({ pressed }) => [styles.next, { backgroundColor: disabled ? OB.systemGray : OB.blue, opacity: pressed ? 0.8 : 1 }]}>
            <OT color={disabled ? OB.secondary : OB.onAccent}>{nav.step === 'completed' && !nav.chapterCompletion ? 'Get Started' : 'Next'}</OT>
            <SymbolView name="chevron.right" size={17} tintColor={disabled ? OB.secondary : OB.onAccent} weight="medium" />
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  progress: { paddingHorizontal: 16, paddingTop: 16, gap: 10 },
  chapterRow: { flexDirection: 'row', alignItems: 'center', gap: 15 },
  chapterCapsule: { width: CAPSULE, height: CAPSULE, borderRadius: CAPSULE / 2, backgroundColor: OB.blue, alignItems: 'center', justifyContent: 'center' },
  segments: { flexDirection: 'row', gap: 4, marginBottom: 20 },
  segment: { flex: 1, height: 4, borderRadius: 2, backgroundColor: OB.track, overflow: 'hidden' },
  segmentFill: { height: 4, borderRadius: 2, backgroundColor: OB.blue },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingTop: 8 },
  headerIcon: { width: 60, height: 60, borderRadius: 30, alignItems: 'center', justifyContent: 'center' },
  footer: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16 },
  back: { flexDirection: 'row', alignItems: 'center', gap: 6, padding: 16 },
  next: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 16, borderRadius: 999 },
});
