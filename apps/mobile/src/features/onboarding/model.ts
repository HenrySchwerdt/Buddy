/**
 * Onboarding steps, chapters and substeps — port of Trio's `OnboardingView+Util.swift`,
 * `OnboardingView+AlgorithmUtil.swift` and the navigation logic in `OnboardingRootView.swift`.
 * Pure TypeScript (no React Native imports) so it can be unit tested.
 */

export type Chapter = 'prepare' | 'therapy' | 'delivery' | 'algorithm' | 'permissions';
export const CHAPTERS: readonly Chapter[] = ['prepare', 'therapy', 'delivery', 'algorithm', 'permissions'];

export const CHAPTER_INFO: Record<Chapter, { title: string; overview: string; duration: string; completed: string }> = {
  prepare: {
    title: 'Prepare Buddy',
    overview: 'Optionally sync with Nightscout and enter essentials.',
    duration: '3-5',
    completed: 'Nightscout setup and unit and pump model selection are all complete.',
  },
  therapy: {
    title: 'Therapy Settings',
    overview: 'Define your glucose targets, basal rates, carb ratios, and insulin sensitivities.',
    duration: '5-10',
    completed: 'Glucose target, basal rates, carb ratios, and insulin sensitivity match your needs.',
  },
  delivery: {
    title: 'Delivery Limits',
    overview: 'Set boundaries for insulin delivery and carb entries to help Buddy keep you safe.',
    duration: '3-5',
    completed: 'Safety boundaries for insulin delivery and carb entries are set to help Buddy keep you safe.',
  },
  algorithm: {
    title: 'Algorithm Settings',
    overview: 'Customize Buddy’s algorithm features. Most users start with the recommended settings.',
    duration: '5-10',
    completed: 'Buddy’s algorithm features are customized to fit your preferences and needs.',
  },
  permissions: {
    title: 'Permission Requests',
    overview: 'Authorize Buddy to send notifications and use Bluetooth. You must allow both for Buddy to work properly.',
    duration: '1',
    completed: 'Notifications and Bluetooth permissions are handled to your liking.',
  },
};

/** Trio's `OnboardingStep` plus Buddy's extra `disclaimer` step before the startup guide. */
export const STEPS = [
  'welcome',
  'disclaimer',
  'startupInfo',
  'overview',
  'nightscout',
  'unitSelection',
  'glucoseTarget',
  'basalRates',
  'carbRatio',
  'insulinSensitivity',
  'deliveryLimits',
  'algorithmSettings',
  'autosensSettings',
  'smbSettings',
  'targetBehavior',
  'notifications',
  'bluetooth',
  'completed',
] as const;
export type Step = (typeof STEPS)[number];

const INFO_STEPS: readonly Step[] = ['welcome', 'disclaimer', 'startupInfo', 'overview', 'completed'];
/** The 13 steps that have a segment in the progress bar. */
export const PROGRESS_STEPS: readonly Step[] = STEPS.filter((s) => !INFO_STEPS.includes(s));

export type Accent = 'blue' | 'green' | 'purple' | 'orange' | 'cyan';

export const STEP_INFO: Record<Step, { title: string; description: string; icon: string; accent: Accent }> = {
  welcome: {
    title: 'Welcome to Buddy',
    description: "Buddy is a powerful app that helps you manage your diabetes. Let's get started by setting up a few important parameters that will help Buddy work effectively for you.",
    icon: 'hand.wave.fill',
    accent: 'blue',
  },
  disclaimer: {
    title: 'Not a Medical Device',
    description: 'Buddy is experimental research software. It is not cleared or approved by any regulator. You use it entirely at your own risk.',
    icon: 'exclamationmark.triangle.fill',
    accent: 'orange',
  },
  startupInfo: {
    title: 'Startup Guide',
    description: 'Buddy comes with a helpful Startup Guide. We recommend opening it now and following along as you go — side by side.',
    icon: 'list.bullet.clipboard.fill',
    accent: 'blue',
  },
  overview: {
    title: 'Overview',
    description: "Buddy's Onboarding takes about 15-30 minutes to complete. We'll guide you through each step.",
    icon: 'checklist.unchecked',
    accent: 'blue',
  },
  nightscout: {
    title: 'Nightscout',
    description: "Nightscout is a cloud-based platform that allows you to store your diabetes data. It's often used by caregivers to remotely monitor what Buddy is doing.",
    icon: 'moon.stars.fill',
    accent: 'blue',
  },
  unitSelection: {
    title: 'Units & Pump',
    description: 'Before you can begin with configuring your therapy settings, Buddy needs to know which units you use for your glucose and insulin measurements (based on your pump model).',
    icon: 'numbers.rectangle',
    accent: 'blue',
  },
  glucoseTarget: {
    title: 'Glucose Targets',
    description: 'Your glucose target is the blood glucose level you aim to maintain. Buddy will use this to calculate insulin doses and provide recommendations.',
    icon: 'target',
    accent: 'green',
  },
  basalRates: {
    title: 'Basal Rates',
    description: 'Your basal profile represents the amount of background insulin you need throughout the day. This helps Buddy calculate your insulin needs.',
    icon: 'chart.xyaxis.line',
    accent: 'purple',
  },
  carbRatio: {
    title: 'Carb Ratios',
    description: 'Your carb ratio tells how many grams of carbohydrates one unit of insulin will cover. This is essential for accurate meal bolus calculations.',
    icon: 'fork.knife',
    accent: 'orange',
  },
  insulinSensitivity: {
    title: 'Insulin Sensitivities',
    description: 'Your insulin sensitivity factor (ISF) indicates how much one unit of insulin will lower your blood glucose. This helps calculate correction boluses.',
    icon: 'drop.fill',
    accent: 'cyan',
  },
  deliveryLimits: {
    title: 'Delivery Limits',
    description: 'Buddy includes several safety limits for insulin delivery and carbohydrate entry, helping ensure a safe and effective experience.',
    icon: 'slider.horizontal.3',
    accent: 'blue',
  },
  algorithmSettings: {
    title: 'Algorithm Settings',
    description: 'Buddy includes several algorithm settings that allow you to customize the oref algorithm behavior to suit your specific needs.',
    icon: 'gearshape.2.fill',
    accent: 'blue',
  },
  autosensSettings: {
    title: 'Autosens',
    description: 'Auto-sensitivity (Autosens) adjusts insulin delivery based on observed sensitivity or resistance.',
    icon: 'dial.low.fill',
    accent: 'blue',
  },
  smbSettings: {
    title: 'Super Micro Bolus',
    description: 'SMB (Super Micro Bolus) is an oref algorithm feature that delivers small frequent boluses instead of temporary basals for faster glucose control.',
    icon: 'bolt.fill',
    accent: 'blue',
  },
  targetBehavior: {
    title: 'Target Behavior',
    description: 'Target Behavior allows you to adjust how temporary targets influence ISF, basal, and auto-targeting based on sensitivity or resistance.',
    icon: 'gyroscope',
    accent: 'blue',
  },
  notifications: {
    title: 'Notifications',
    description: ' Allow Buddy to send you Notifications. These may include alerts, sounds, and icon badges.',
    icon: 'bell.badge.fill',
    accent: 'blue',
  },
  bluetooth: {
    title: 'Bluetooth',
    description: 'Allow Buddy to use Bluetooth to communicate with your insulin pump and CGM.',
    icon: 'dot.radiowaves.left.and.right',
    accent: 'blue',
  },
  completed: {
    title: 'All Set!',
    description: "Great job! You've completed the initial setup of Buddy. You can always adjust these settings later in the app.",
    icon: 'checkmark.circle.fill',
    accent: 'blue',
  },
};

export function chapterOf(step: Step): Chapter | null {
  switch (step) {
    case 'nightscout':
    case 'unitSelection':
      return 'prepare';
    case 'glucoseTarget':
    case 'basalRates':
    case 'carbRatio':
    case 'insulinSensitivity':
      return 'therapy';
    case 'deliveryLimits':
      return 'delivery';
    case 'algorithmSettings':
    case 'autosensSettings':
    case 'smbSettings':
    case 'targetBehavior':
      return 'algorithm';
    case 'notifications':
    case 'bluetooth':
      return 'permissions';
    default:
      return null;
  }
}

/** Steps after which a chapter-completion screen is shown (substep-driven ones are handled in `next`). */
const CHAPTER_COMPLETION: Partial<Record<Step, Chapter>> = { unitSelection: 'prepare', insulinSensitivity: 'therapy' };

// MARK: Substeps

/** Trio's StartupSubstep. `returningUser` (index 1) is skipped: Buddy installs are always fresh. */
export const STARTUP_SUBSTEPS = ['startupGuide', 'returningUser', 'forceCloseWarning'] as const;
export const NIGHTSCOUT_SUBSTEPS = ['setupSelection', 'connectToNightscout', 'uploadToNightscout', 'uploadGlucoseToNightscout', 'importFromNightscout'] as const;
export const DELIVERY_SUBSTEPS = ['maxIOB', 'maxBolus', 'maxBasal', 'maxCOB', 'minimumSafetyThreshold'] as const;
export const ALGORITHM_OVERVIEW_SUBSTEPS = ['contents', 'importantNotes'] as const;
export const AUTOSENS_SUBSTEPS = ['autosensMin', 'autosensMax', 'rewindResetsAutosens'] as const;
export const SMB_SUBSTEPS = [
  'enableSMBAlways',
  'enableSMBWithCOB',
  'enableSMBWithTempTarget',
  'enableSMBAfterCarbs',
  'enableSMBWithHighGlucoseTarget',
  'allowSMBWithHighTempTarget',
  'enableUAM',
  'maxSMBMinutes',
  'maxUAMMinutes',
  'maxDeltaGlucoseThreshold',
] as const;
export const TARGET_BEHAVIOR_SUBSTEPS = ['highTempTargetRaisesSensitivity', 'lowTempTargetLowersSensitivity', 'sensitivityRaisesTarget', 'resistanceLowersTarget', 'halfBasalTarget'] as const;

export type DeliverySubstep = (typeof DELIVERY_SUBSTEPS)[number];
export type AlgorithmSubstep = (typeof AUTOSENS_SUBSTEPS)[number] | (typeof SMB_SUBSTEPS)[number] | (typeof TARGET_BEHAVIOR_SUBSTEPS)[number];
export type NightscoutSetupOption = 'setup' | 'skip' | null;
export type NightscoutImportOption = 'import' | 'skip' | null;

export const IS_FRESH_INSTALL = true;

export interface NavState {
  readonly step: Step;
  readonly chapterCompletion: Chapter | null;
  readonly startup: number;
  readonly nightscout: number;
  readonly delivery: number;
  readonly algorithmOverview: number;
  /** Index into `autosensSubsteps(reportsRewind)`. */
  readonly autosens: number;
  readonly smb: number;
  readonly targetBehavior: number;
}

export const INITIAL_NAV: NavState = { step: 'welcome', chapterCompletion: null, startup: 0, nightscout: 0, delivery: 0, algorithmOverview: 0, autosens: 0, smb: 0, targetBehavior: 0 };

export interface NavContext {
  readonly nightscoutSetup: NightscoutSetupOption;
  readonly enableSMBAlways: boolean;
  readonly reportsRewindEvents: boolean;
}

/** `filteredAutosensSettingsSubsteps`: rewind question only for pumps that report rewinds. */
export const autosensSubsteps = (reportsRewind: boolean): readonly AlgorithmSubstep[] => (reportsRewind ? AUTOSENS_SUBSTEPS : AUTOSENS_SUBSTEPS.slice(0, 2));

const stepAfter = (s: Step): Step | null => STEPS[STEPS.indexOf(s) + 1] ?? null;
const stepBefore = (s: Step): Step | null => STEPS[STEPS.indexOf(s) - 1] ?? null;
const SMB_ALWAYS = SMB_SUBSTEPS.indexOf('enableSMBAlways');
const SMB_HIGH_TT = SMB_SUBSTEPS.indexOf('allowSMBWithHighTempTarget');
const STARTUP_RETURNING = STARTUP_SUBSTEPS.indexOf('returningUser');

/** Substep index of the current step and the number of substeps (for the progress bar). */
export function substepProgress(nav: NavState, ctx: NavContext): { current: number; total: number } | null {
  switch (nav.step) {
    case 'nightscout':
      return { current: nav.nightscout, total: NIGHTSCOUT_SUBSTEPS.length };
    case 'deliveryLimits':
      return { current: nav.delivery, total: DELIVERY_SUBSTEPS.length };
    case 'algorithmSettings':
      return { current: nav.algorithmOverview, total: ALGORITHM_OVERVIEW_SUBSTEPS.length };
    case 'autosensSettings':
      return { current: nav.autosens, total: autosensSubsteps(ctx.reportsRewindEvents).length };
    case 'smbSettings':
      return { current: nav.smb, total: SMB_SUBSTEPS.length };
    case 'targetBehavior':
      return { current: nav.targetBehavior, total: TARGET_BEHAVIOR_SUBSTEPS.length };
    default:
      return null;
  }
}

/** Fill fraction (0…1) of a progress-bar segment — `OnboardingProgressBar.fillFraction`. */
export function segmentFill(segment: Step, nav: NavState, ctx: NavContext): number {
  if (nav.step === 'completed') return 1;
  const current = PROGRESS_STEPS.indexOf(nav.step);
  const index = PROGRESS_STEPS.indexOf(segment);
  if (current >= 0 && index < current) return 1;
  if (segment === nav.step) {
    const sub = substepProgress(nav, ctx);
    return sub ? (sub.current + 1) / sub.total : 1;
  }
  // Skipped Nightscout counts as done once the user is past it.
  if (segment === 'nightscout' && ctx.nightscoutSetup === 'skip' && current > index) return 1;
  return 0;
}

/** Synchronous forward navigation (`handleNextNavigation`). Permission, import and finish side effects live in the root view. */
export function nextNav(nav: NavState, ctx: NavContext): NavState {
  if (nav.chapterCompletion) {
    const next = stepAfter(nav.step);
    return { ...nav, chapterCompletion: null, step: next ?? nav.step };
  }
  const chapter = CHAPTER_COMPLETION[nav.step];
  if (chapter) return { ...nav, chapterCompletion: chapter };
  const advance = (patch: Partial<NavState> = {}): NavState => ({ ...nav, ...patch, step: stepAfter(nav.step) ?? nav.step });

  switch (nav.step) {
    case 'startupInfo': {
      let next = nav.startup + 1;
      if (IS_FRESH_INSTALL && next === STARTUP_RETURNING) next += 1;
      return next < STARTUP_SUBSTEPS.length ? { ...nav, startup: next } : advance({ startup: 0 });
    }
    case 'nightscout': {
      if (nav.nightscout === 0 && ctx.nightscoutSetup === 'skip') return advance();
      if (nav.nightscout < NIGHTSCOUT_SUBSTEPS.length - 1) return { ...nav, nightscout: nav.nightscout + 1 };
      return advance();
    }
    case 'deliveryLimits':
      return nav.delivery < DELIVERY_SUBSTEPS.length - 1 ? { ...nav, delivery: nav.delivery + 1 } : { ...nav, delivery: DELIVERY_SUBSTEPS.length - 1, chapterCompletion: 'delivery' };
    case 'algorithmSettings':
      return nav.algorithmOverview < ALGORITHM_OVERVIEW_SUBSTEPS.length - 1 ? { ...nav, algorithmOverview: nav.algorithmOverview + 1 } : advance({ algorithmOverview: 0 });
    case 'autosensSettings':
      return nav.autosens + 1 < autosensSubsteps(ctx.reportsRewindEvents).length ? { ...nav, autosens: nav.autosens + 1 } : advance({ autosens: 0 });
    case 'smbSettings':
      if (nav.smb < SMB_SUBSTEPS.length - 1) return { ...nav, smb: ctx.enableSMBAlways && nav.smb === SMB_ALWAYS ? SMB_HIGH_TT : nav.smb + 1 };
      return advance({ smb: 0 });
    case 'targetBehavior':
      return nav.targetBehavior < TARGET_BEHAVIOR_SUBSTEPS.length - 1
        ? { ...nav, targetBehavior: nav.targetBehavior + 1 }
        : { ...nav, targetBehavior: TARGET_BEHAVIOR_SUBSTEPS.length - 1, chapterCompletion: 'algorithm' };
    case 'completed':
      return nav;
    default:
      return advance();
  }
}

/** Backward navigation (`handleBackNavigation`). */
export function backNav(nav: NavState, ctx: NavContext): NavState {
  if (nav.chapterCompletion) return { ...nav, chapterCompletion: null };
  const previous = stepBefore(nav.step);
  const retreat = (patch: Partial<NavState> = {}): NavState => ({ ...nav, ...patch, step: previous ?? nav.step });

  switch (nav.step) {
    case 'startupInfo': {
      let prev = nav.startup - 1;
      if (IS_FRESH_INSTALL && prev === STARTUP_RETURNING) prev -= 1;
      return prev >= 0 ? { ...nav, startup: prev } : retreat({ startup: 0 });
    }
    case 'overview':
      return retreat({ startup: STARTUP_SUBSTEPS.length - 1 });
    case 'nightscout':
      return nav.nightscout === 0 ? retreat({ nightscout: 0 }) : { ...nav, nightscout: nav.nightscout - 1 };
    case 'unitSelection':
      // Coming back to Nightscout lands on the substep the user left from (last one, or the selection if skipped).
      return retreat({ nightscout: ctx.nightscoutSetup === 'skip' ? 0 : nav.nightscout });
    case 'deliveryLimits':
      return nav.delivery > 0 ? { ...nav, delivery: nav.delivery - 1 } : retreat({ delivery: 0 });
    case 'algorithmSettings':
      return nav.algorithmOverview > 0 ? { ...nav, algorithmOverview: nav.algorithmOverview - 1 } : retreat({ delivery: DELIVERY_SUBSTEPS.length - 1, autosens: 0 });
    case 'autosensSettings':
      return nav.autosens > 0 ? { ...nav, autosens: nav.autosens - 1 } : retreat({ autosens: 0, algorithmOverview: ALGORITHM_OVERVIEW_SUBSTEPS.length - 1 });
    case 'smbSettings':
      if (nav.smb > 0) return { ...nav, smb: ctx.enableSMBAlways && nav.smb === SMB_HIGH_TT ? SMB_ALWAYS : nav.smb - 1 };
      return retreat({ smb: 0, autosens: autosensSubsteps(ctx.reportsRewindEvents).length - 1 });
    case 'targetBehavior':
      return nav.targetBehavior > 0 ? { ...nav, targetBehavior: nav.targetBehavior - 1 } : retreat({ targetBehavior: 0, smb: SMB_SUBSTEPS.length - 1 });
    case 'notifications':
      return retreat({ targetBehavior: TARGET_BEHAVIOR_SUBSTEPS.length - 1 });
    case 'completed':
      return { ...nav, step: 'bluetooth' };
    default:
      return retreat();
  }
}
