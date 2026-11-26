import { BuddyNative } from '../../modules/buddy-native';
import { createTaskGuard } from './task-guard';

/** The app-wide guard, backed by `UIApplication.beginBackgroundTask` when the native module is present. */
export const backgroundTasks = createTaskGuard(BuddyNative);

/** Runs `fn` inside a background task (iOS), ended in `finally`. */
export const withBackgroundTask = backgroundTasks.run;
