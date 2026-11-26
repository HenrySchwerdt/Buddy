/**
 * Config plugin for the native OS integrations (modules/buddy-native, targets/live-activity).
 *
 * iOS
 *  - Info.plist: NSSupportsLiveActivities (+ frequent updates), so the app may request a Live Activity.
 *  - App Intents (Shortcuts app / Siri): plugins/buddy-native/ios/BuddyAppIntents.swift is copied into the app
 *    target. App Intents metadata is only reliably extracted from the app target itself, which is why the file is
 *    not part of the local Expo module (a static pod).
 *  - The Live Activity widget extension is created by @bacons/apple-targets from targets/live-activity.
 * Android
 *  - Static launcher shortcuts (res/xml/shortcuts.xml, strings) and the manifest meta-data that points to them.
 *    Dynamic shortcuts for presets are set at runtime by the module. The service, permissions and notification
 *    icon come from the module's own manifest/resources.
 */
const fs = require('fs');
const path = require('path');
const { AndroidConfig, IOSConfig, withAndroidManifest, withDangerousMod, withInfoPlist, withStringsXml, withXcodeProject } = require('expo/config-plugins');

const INTENTS_FILE = 'BuddyAppIntents.swift';

const withLiveActivityPlist = (config) =>
  withInfoPlist(config, (c) => {
    c.modResults.NSSupportsLiveActivities = true;
    c.modResults.NSSupportsLiveActivitiesFrequentUpdates = true;
    return c;
  });

const withAppIntents = (config) =>
  withXcodeProject(config, (c) => {
    const project = c.modResults;
    const name = c.modRequest.projectName;
    const dir = path.join(c.modRequest.platformProjectRoot, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'buddy-native', 'ios', INTENTS_FILE), path.join(dir, INTENTS_FILE));
    const filepath = `${name}/${INTENTS_FILE}`;
    if (!project.hasFile(filepath)) {
      IOSConfig.XcodeUtils.addBuildSourceFileToGroup({ filepath, groupName: name, project });
    }
    return c;
  });

const SHORTCUTS_XML = `<?xml version="1.0" encoding="utf-8"?>
<shortcuts xmlns:android="http://schemas.android.com/apk/res/android">
  <shortcut
    android:shortcutId="treatment"
    android:enabled="true"
    android:shortcutShortLabel="@string/buddy_shortcut_treatment_short"
    android:shortcutLongLabel="@string/buddy_shortcut_treatment_long">
    <intent android:action="android.intent.action.VIEW" android:data="buddy://treatment" android:targetPackage="PACKAGE" android:targetClass="PACKAGE.MainActivity" />
  </shortcut>
  <shortcut
    android:shortcutId="state"
    android:enabled="true"
    android:shortcutShortLabel="@string/buddy_shortcut_state_short"
    android:shortcutLongLabel="@string/buddy_shortcut_state_long">
    <intent android:action="android.intent.action.VIEW" android:data="buddy://shortcut?action=state" android:targetPackage="PACKAGE" android:targetClass="PACKAGE.MainActivity" />
  </shortcut>
  <shortcut
    android:shortcutId="cancel-override"
    android:enabled="true"
    android:shortcutShortLabel="@string/buddy_shortcut_cancel_override_short"
    android:shortcutLongLabel="@string/buddy_shortcut_cancel_override_long">
    <intent android:action="android.intent.action.VIEW" android:data="buddy://shortcut?action=override-cancel" android:targetPackage="PACKAGE" android:targetClass="PACKAGE.MainActivity" />
  </shortcut>
</shortcuts>
`;

const STRINGS = {
  buddy_shortcut_treatment_short: 'Bolus / Carbs',
  buddy_shortcut_treatment_long: 'Add a bolus or carbs',
  buddy_shortcut_state_short: 'Current state',
  buddy_shortcut_state_long: 'Glucose, IOB and COB',
  buddy_shortcut_cancel_override_short: 'End override',
  buddy_shortcut_cancel_override_long: 'Cancel the running override',
};

const withAndroidShortcutFile = (config) =>
  withDangerousMod(config, [
    'android',
    (c) => {
      const pkg = c.android?.package;
      if (!pkg) throw new Error('with-buddy-native: android.package must be set in app.json.');
      const dir = path.join(c.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res', 'xml');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'buddy_shortcuts.xml'), SHORTCUTS_XML.replace(/PACKAGE/g, pkg));
      return c;
    },
  ]);

const withAndroidShortcutStrings = (config) =>
  withStringsXml(config, (c) => {
    c.modResults = AndroidConfig.Strings.setStringItem(
      Object.entries(STRINGS).map(([k, v]) => ({ $: { name: k, translatable: 'false' }, _: v })),
      c.modResults,
    );
    return c;
  });

const withAndroidShortcutManifest = (config) =>
  withAndroidManifest(config, (c) => {
    const main = AndroidConfig.Manifest.getMainActivityOrThrow(c.modResults);
    const meta = main['meta-data'] ?? [];
    if (!meta.some((m) => m.$['android:name'] === 'android.app.shortcuts')) {
      meta.push({ $: { 'android:name': 'android.app.shortcuts', 'android:resource': '@xml/buddy_shortcuts' } });
    }
    main['meta-data'] = meta;
    return c;
  });

module.exports = (config) => {
  config = withLiveActivityPlist(config);
  config = withAppIntents(config);
  config = withAndroidShortcutFile(config);
  config = withAndroidShortcutStrings(config);
  config = withAndroidShortcutManifest(config);
  return config;
};
