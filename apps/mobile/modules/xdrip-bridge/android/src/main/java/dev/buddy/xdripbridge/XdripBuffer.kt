package dev.buddy.xdripbridge

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/** One xDrip+ BgEstimate reading. [value] is mg/dL, [date] epoch ms of the measurement. */
data class XdripReading(val value: Double, val date: Long, val direction: String?) {
  fun toMap(): Map<String, Any?> = mapOf("value" to value, "date" to date, "direction" to direction)
}

/**
 * Process-wide buffer of recent readings, persisted in SharedPreferences so readings received while
 * the JS runtime (or the whole app process) was not running are still there on the next poll.
 * Only the timestamp-deduplicated newest [MAX_ENTRIES] are kept; plausibility and future-date checks
 * happen again on the TypeScript side.
 */
object XdripBuffer {
  private const val PREFS = "dev.buddy.xdripbridge"
  private const val KEY = "readings"
  private const val MAX_ENTRIES = 120

  @Volatile
  var listener: ((XdripReading) -> Unit)? = null

  private val lock = Any()

  fun add(context: Context, reading: XdripReading) {
    synchronized(lock) {
      val merged = (load(context).filter { it.date != reading.date } + reading).sortedBy { it.date }.takeLast(MAX_ENTRIES)
      val arr = JSONArray()
      merged.forEach { r ->
        arr.put(JSONObject().put("v", r.value).put("t", r.date).put("d", r.direction ?: JSONObject.NULL))
      }
      context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, arr.toString()).apply()
    }
    listener?.invoke(reading)
  }

  fun snapshot(context: Context): List<XdripReading> = synchronized(lock) { load(context) }

  private fun load(context: Context): List<XdripReading> {
    val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null) ?: return emptyList()
    return try {
      val arr = JSONArray(raw)
      (0 until arr.length()).mapNotNull { i ->
        val o = arr.optJSONObject(i) ?: return@mapNotNull null
        XdripReading(o.getDouble("v"), o.getLong("t"), if (o.isNull("d")) null else o.getString("d"))
      }
    } catch (e: Exception) {
      emptyList()
    }
  }
}
