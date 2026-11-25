import { Platform } from 'react-native';

/** Name of the phone's settings app, for copy that sends the user there (Trio says "iOS Settings"). */
export const SYSTEM_SETTINGS = Platform.OS === 'android' ? 'Android Settings' : 'iOS Settings';
