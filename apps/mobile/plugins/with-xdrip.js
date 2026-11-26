/**
 * Config plugin for the xDrip CGM source (modules/xdrip-bridge).
 *
 * iOS: adds the App Group entitlement and the Info.plist key `AppGroupID` that the native module reads
 * (the same key Trio uses). xDrip4iOS and Buddy must share the SAME group id, so both must be signed by
 * the same Apple developer team. In Trio the id is `group.org.nightscout.<TEAM_ID>.trio.trio-app-group`.
 *
 * Options (all optional):
 *   appGroupId        full group id; wins over developmentTeam
 *   developmentTeam   10-character Apple team id; derives the Trio-style group id
 * Without either, the placeholder id is written and the source reports "not configured" at runtime.
 * Environment fallbacks: BUDDY_XDRIP_APP_GROUP_ID, BUDDY_DEVELOPMENT_TEAM.
 *
 * Android needs nothing here: the receiver is declared in the module's own manifest.
 */
const { withEntitlementsPlist, withInfoPlist } = require('expo/config-plugins');

const PLACEHOLDER_TEAM = 'XXXXXXXXXX';
const groupFromTeam = (team) => `group.org.nightscout.${team}.trio.trio-app-group`;
const GROUP_ID = /^group\.[A-Za-z0-9.-]+$/;
const TEAM_ID = /^[A-Z0-9]{10}$/;

function resolveAppGroupId(options = {}) {
  const explicit = options.appGroupId || process.env.BUDDY_XDRIP_APP_GROUP_ID;
  if (explicit) {
    if (!GROUP_ID.test(explicit)) throw new Error(`with-xdrip: appGroupId "${explicit}" must look like "group.<reverse.dns>".`);
    return explicit;
  }
  const team = options.developmentTeam || process.env.BUDDY_DEVELOPMENT_TEAM;
  if (team) {
    if (!TEAM_ID.test(team)) throw new Error(`with-xdrip: developmentTeam "${team}" must be a 10-character Apple team id.`);
    return groupFromTeam(team);
  }
  return groupFromTeam(PLACEHOLDER_TEAM);
}

const withXdrip = (config, options) => {
  const appGroupId = resolveAppGroupId(options);
  const isPlaceholder = appGroupId.includes(PLACEHOLDER_TEAM);
  if (isPlaceholder) {
    console.warn('[with-xdrip] No appGroupId/developmentTeam set: using a placeholder App Group. The xDrip source will report "not configured" until you set one.');
  }

  config = withEntitlementsPlist(config, (c) => {
    const key = 'com.apple.security.application-groups';
    const groups = new Set(c.modResults[key] ?? []);
    groups.add(appGroupId);
    c.modResults[key] = [...groups];
    return c;
  });

  config = withInfoPlist(config, (c) => {
    c.modResults.AppGroupID = appGroupId;
    // Lets the app open xDrip4iOS (Trio does the same via its URL scheme).
    const schemes = new Set(c.modResults.LSApplicationQueriesSchemes ?? []);
    schemes.add('xdripswift');
    c.modResults.LSApplicationQueriesSchemes = [...schemes];
    return c;
  });

  return config;
};

module.exports = withXdrip;
module.exports.resolveAppGroupId = resolveAppGroupId;
