package dev.buddy.xdripbridge

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Receives xDrip+'s local broadcast `com.eveningoutpost.dexdrip.BgEstimate`:
 *  - `com.eveningoutpost.dexdrip.Extras.BgEstimate`  Double, mg/dL
 *  - `com.eveningoutpost.dexdrip.Extras.Time`        Long, epoch ms of the measurement
 *  - `com.eveningoutpost.dexdrip.Extras.BgSlopeName` String ("Flat", "FortyFiveUp", ... or "NOT COMPUTABLE")
 * Incomplete or non-finite broadcasts are dropped, never repaired.
 */
class XdripBroadcastReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != ACTION) return
    val value = intent.getDoubleExtra(EXTRA_BG, Double.NaN)
    val time = intent.getLongExtra(EXTRA_TIME, 0L)
    if (!value.isFinite() || value <= 0.0 || time <= 0L) return
    XdripBuffer.add(context.applicationContext, XdripReading(value, time, intent.getStringExtra(EXTRA_SLOPE_NAME)))
  }

  companion object {
    const val ACTION = "com.eveningoutpost.dexdrip.BgEstimate"
    const val EXTRA_BG = "com.eveningoutpost.dexdrip.Extras.BgEstimate"
    const val EXTRA_TIME = "com.eveningoutpost.dexdrip.Extras.Time"
    const val EXTRA_SLOPE_NAME = "com.eveningoutpost.dexdrip.Extras.BgSlopeName"
  }
}
