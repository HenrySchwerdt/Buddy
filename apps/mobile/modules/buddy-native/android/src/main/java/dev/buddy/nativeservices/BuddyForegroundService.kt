package dev.buddy.nativeservices

import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.content.ContextCompat
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

/**
 * Foreground service that keeps Buddy's process alive. Being a HeadlessJsTaskService it also runs the JS task
 * "BuddyForeground" (never times out): while a headless task runs React Native keeps JS timers going in the
 * background, and after a process kill the task boots the runtime without any UI.
 */
class BuddyForegroundService : HeadlessJsTaskService() {
  override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig =
    HeadlessJsTaskConfig(TASK_NAME, Arguments.createMap(), 0, true)

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val title = intent?.getStringExtra(EXTRA_TITLE) ?: "Buddy"
    val text = intent?.getStringExtra(EXTRA_TEXT) ?: "Looping in the background"
    val whenMs = intent?.getLongExtra(EXTRA_WHEN, 0L) ?: 0L
    if (!enterForeground(BuddyNotifications.build(this, title, text, whenMs))) {
      stopSelf()
      return START_NOT_STICKY
    }
    running = true
    return super.onStartCommand(intent, flags, startId)
  }

  override fun onDestroy() {
    running = false
    super.onDestroy()
  }

  /** connectedDevice needs a granted Bluetooth permission; without it Android throws, so fall back to specialUse. */
  private fun enterForeground(notification: android.app.Notification): Boolean {
    val id = BuddyNotifications.NOTIFICATION_ID
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
      startForeground(id, notification)
      return true
    }
    val types = mutableListOf(ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) types.add(ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
    var failure: Exception? = null
    for (type in types) {
      try {
        startForeground(id, notification, type)
        lastError = null
        return true
      } catch (e: SecurityException) {
        failure = e
      } catch (e: IllegalStateException) {
        failure = e
        break
      }
    }
    lastError = failure?.message ?: "startForeground failed"
    return false
  }

  companion object {
    const val TASK_NAME = "BuddyForeground"
    const val EXTRA_TITLE = "title"
    const val EXTRA_TEXT = "text"
    const val EXTRA_WHEN = "when"

    @Volatile var running = false
    @Volatile var lastError: String? = null

    fun start(context: Context, title: String, text: String, whenMs: Long): Boolean {
      val intent = Intent(context, BuddyForegroundService::class.java)
        .putExtra(EXTRA_TITLE, title)
        .putExtra(EXTRA_TEXT, text)
        .putExtra(EXTRA_WHEN, whenMs)
      return try {
        ContextCompat.startForegroundService(context, intent)
        lastError = null
        true
      } catch (e: Exception) {
        // Android 12+ refuses to start a foreground service from the background.
        lastError = e.message ?: e.javaClass.simpleName
        false
      }
    }

    fun stop(context: Context) {
      context.stopService(Intent(context, BuddyForegroundService::class.java))
      running = false
    }
  }
}
