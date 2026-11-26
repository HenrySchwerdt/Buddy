package dev.buddy.nativeservices

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

class NativeShortcutRecord : Record {
  @Field var id: String = ""
  @Field var shortLabel: String = ""
  @Field var longLabel: String = ""
  @Field var url: String = ""
}

class BuddyNativeModule : Module() {
  private val context: Context
    get() = requireNotNull(appContext.reactContext) { "React context is not available" }.applicationContext

  override fun definition() = ModuleDefinition {
    Name("BuddyNative")

    AsyncFunction("startForegroundService") { title: String, text: String, whenMs: Double ->
      BuddyForegroundService.start(context, title, text, whenMs.toLong())
    }

    Function("updateForegroundNotification") { title: String, text: String, whenMs: Double ->
      BuddyNotifications.update(context, title, text, whenMs.toLong())
    }

    Function("stopForegroundService") { -> BuddyForegroundService.stop(context) }

    Function("isForegroundServiceRunning") { -> BuddyForegroundService.running }

    Function("foregroundServiceError") { -> BuddyForegroundService.lastError }

    /** iOS-only concept (UIApplication background tasks). Android keeps the app alive with the foreground service; 0 = no task. */
    Function("beginBackgroundTask") { _: String -> 0 }

    Function("endBackgroundTask") { _: Int -> }

    /** Dynamic shortcuts (long-press the launcher icon): override and temp target presets. Static ones live in the manifest. */
    Function("setDynamicShortcuts") { shortcuts: List<NativeShortcutRecord> ->
      val ctx = context
      val iconRes = ctx.resources.getIdentifier("ic_buddy_status", "drawable", ctx.packageName)
      val limit = (ShortcutManagerCompat.getMaxShortcutCountPerActivity(ctx) - STATIC_SHORTCUTS).coerceAtLeast(0)
      val infos = shortcuts.take(limit).filter { it.id.isNotBlank() && it.url.startsWith("buddy://") }.map {
        val builder = ShortcutInfoCompat.Builder(ctx, it.id)
          .setShortLabel(it.shortLabel.ifBlank { it.id })
          .setLongLabel(it.longLabel.ifBlank { it.shortLabel })
          .setIntent(Intent(Intent.ACTION_VIEW, Uri.parse(it.url)).setPackage(ctx.packageName))
        if (iconRes != 0) builder.setIcon(IconCompat.createWithResource(ctx, iconRes))
        builder.build()
      }
      ShortcutManagerCompat.setDynamicShortcuts(ctx, infos)
    }
  }

  private companion object {
    /** Entries in plugins/with-buddy-shortcuts.js's shortcuts.xml. */
    const val STATIC_SHORTCUTS = 3
  }
}
