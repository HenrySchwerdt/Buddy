package dev.buddy.nativeservices

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat

/** The ongoing status notification (Trio Live Activity content: glucose, trend, delta, IOB, COB, last loop). */
object BuddyNotifications {
  const val CHANNEL_ID = "buddy_status"
  const val NOTIFICATION_ID = 7101

  fun ensureChannel(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(NotificationManager::class.java)
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return
    val channel = NotificationChannel(CHANNEL_ID, "Buddy status", NotificationManager.IMPORTANCE_LOW).apply {
      description = "Glucose, IOB and COB while Buddy is looping in the background."
      setShowBadge(false)
      setSound(null, null)
      enableVibration(false)
    }
    manager.createNotificationChannel(channel)
  }

  fun build(context: Context, title: String, text: String, whenMs: Long): Notification {
    ensureChannel(context)
    val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)?.apply {
      flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
    }
    val tap = launch?.let { PendingIntent.getActivity(context, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT) }
    val builder = NotificationCompat.Builder(context, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_buddy_status)
      .setContentTitle(title)
      .setContentText(text)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setSilent(true)
      .setCategory(NotificationCompat.CATEGORY_STATUS)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setContentIntent(tap)
    if (whenMs > 0) builder.setWhen(whenMs).setShowWhen(true)
    return builder.build()
  }

  fun update(context: Context, title: String, text: String, whenMs: Long) {
    // notify() on the service's own id replaces the foreground notification in place.
    val manager = context.getSystemService(NotificationManager::class.java)
    manager.notify(NOTIFICATION_ID, build(context, title, text, whenMs))
  }
}
