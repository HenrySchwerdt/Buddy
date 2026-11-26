/**
 * Live Activity widget extension (lock screen + Dynamic Island), built by @bacons/apple-targets.
 * The data type (BuddyActivityAttributes.swift) is duplicated in modules/buddy-native/ios: keep both identical.
 * Running on a device needs `ios.appleTeamId` (or a team in Xcode) for signing the extension.
 *
 * @type {import('@bacons/apple-targets/app.plugin').Config}
 */
module.exports = {
  type: 'widget',
  name: 'BuddyLiveActivity',
  displayName: 'Buddy',
  deploymentTarget: '16.4',
  frameworks: ['SwiftUI', 'WidgetKit', 'ActivityKit'],
};
