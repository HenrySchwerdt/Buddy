package dev.buddy.xdripbridge

import android.content.Context
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class XdripBridgeModule : Module() {
  private val context: Context
    get() = requireNotNull(appContext.reactContext) { "React context is not available" }.applicationContext

  override fun definition() = ModuleDefinition {
    Name("XdripBridge")

    Events("onReading")

    OnCreate {
      XdripBuffer.listener = { r -> sendEvent("onReading", r.toMap()) }
    }

    OnDestroy {
      XdripBuffer.listener = null
    }

    // The manifest receiver is always present once the module is linked.
    AsyncFunction("isConfigured") { -> true }

    AsyncFunction("bufferedReadings") { ->
      XdripBuffer.snapshot(context).map { it.toMap() }
    }
  }
}
