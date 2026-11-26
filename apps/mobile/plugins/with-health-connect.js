const { AndroidConfig, createRunOncePlugin, withAndroidManifest } = require('expo/config-plugins');

/**
 * Health Connect write permissions Buddy asks for (react-native-health-connect only adds the rationale
 * activity). Glucose and carbs; Health Connect has no insulin record.
 */
const PERMISSIONS = ['android.permission.health.WRITE_BLOOD_GLUCOSE', 'android.permission.health.WRITE_NUTRITION'];

const withHealthConnectPermissions = (config) =>
  withAndroidManifest(config, (c) => {
    AndroidConfig.Permissions.ensurePermissions(c.modResults, PERMISSIONS);
    return c;
  });

module.exports = createRunOncePlugin(withHealthConnectPermissions, 'with-health-connect', '1.0.0');
