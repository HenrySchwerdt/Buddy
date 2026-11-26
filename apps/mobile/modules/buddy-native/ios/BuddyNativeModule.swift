import ActivityKit
import ExpoModulesCore
import Foundation
import UIKit

/// iOS side of the native services:
///  - Live Activity start/update/end (ActivityKit). The UI lives in the widget extension target.
///  - `setShortcutState`: stores a JSON snapshot in UserDefaults for the App Intents (Get State, bolus switch).
///  - `beginBackgroundTask` / `endBackgroundTask`: UIApplication background tasks, so a loop run or a BLE reading that
///    started while the app was woken in the background can finish before iOS suspends it again.
public class BuddyNativeModule: Module {
  private static let shortcutStateKey = "buddy.shortcutState.v1"

  /// Open background tasks by the id handed to JS. Only touched on the main thread.
  private var backgroundTasks: [Int: UIBackgroundTaskIdentifier] = [:]
  private var nextBackgroundTaskId = 1

  private func onMain<T>(_ work: () -> T) -> T {
    Thread.isMainThread ? work() : DispatchQueue.main.sync(execute: work)
  }

  /// Returns 0 when iOS refuses a task (no time left, or the app may not start one).
  private func beginBackgroundTask(named name: String) -> Int {
    onMain {
      let id = nextBackgroundTaskId
      nextBackgroundTaskId += 1
      let identifier = UIApplication.shared.beginBackgroundTask(withName: name) { [weak self] in
        // The system's time is up: end the task here, or iOS terminates the app. JS ends it again harmlessly.
        self?.finishBackgroundTask(id)
      }
      if identifier == .invalid { return 0 }
      backgroundTasks[id] = identifier
      return id
    }
  }

  /// Idempotent: unknown or already ended ids are ignored.
  private func finishBackgroundTask(_ id: Int) {
    onMain {
      guard let identifier = backgroundTasks.removeValue(forKey: id) else { return }
      UIApplication.shared.endBackgroundTask(identifier)
    }
  }

  private func number(_ d: [String: Any], _ key: String) -> Double {
    (d[key] as? NSNumber)?.doubleValue ?? 0
  }

  private func ints(_ d: [String: Any], _ key: String) -> [Int] {
    ((d[key] as? [Any]) ?? []).compactMap { ($0 as? NSNumber)?.intValue }
  }

  private func state(from d: [String: Any]) -> BuddyActivityAttributes.ContentState {
    BuddyActivityAttributes.ContentState(
      glucose: d["glucose"] as? String ?? "--",
      unit: d["unit"] as? String ?? "mg/dL",
      arrow: d["arrow"] as? String ?? "",
      delta: d["delta"] as? String ?? "",
      glucoseMgdl: Int(number(d, "glucoseMgdl")),
      readingAt: number(d, "readingAt"),
      lastLoopAt: number(d, "lastLoopAt"),
      iob: d["iob"] as? String ?? "--",
      cob: d["cob"] as? String ?? "--",
      low: Int(number(d, "low")),
      high: Int(number(d, "high")),
      stale: (d["stale"] as? Bool) ?? false,
      style: d["style"] as? String ?? "simple",
      fontSize: d["fontSize"] as? String ?? "large",
      showIob: (d["showIob"] as? Bool) ?? true,
      showCob: (d["showCob"] as? Bool) ?? true,
      showUpdated: (d["showUpdated"] as? Bool) ?? true,
      chartAges: ints(d, "chartAges"),
      chartValues: ints(d, "chartValues")
    )
  }

  private func content(_ d: [String: Any], staleAt: Double) -> ActivityContent<BuddyActivityAttributes.ContentState> {
    ActivityContent(state: state(from: d), staleDate: Date(timeIntervalSince1970: staleAt))
  }

  public func definition() -> ModuleDefinition {
    Name("BuddyNative")

    Function("liveActivityStatus") { () -> [String: Any] in
      let running = Activity<BuddyActivityAttributes>.activities.first
      return [
        "supported": true,
        "enabled": ActivityAuthorizationInfo().areActivitiesEnabled,
        "active": running != nil,
        "startedAt": running?.attributes.startedAt ?? 0,
      ]
    }

    AsyncFunction("startLiveActivity") { (d: [String: Any], staleAt: Double) async -> Bool in
      guard ActivityAuthorizationInfo().areActivitiesEnabled else { return false }
      for old in Activity<BuddyActivityAttributes>.activities {
        await old.end(nil, dismissalPolicy: .immediate)
      }
      do {
        _ = try Activity<BuddyActivityAttributes>.request(
          attributes: BuddyActivityAttributes(startedAt: Date().timeIntervalSince1970),
          content: self.content(d, staleAt: staleAt),
          pushType: nil
        )
        return true
      } catch {
        return false
      }
    }

    AsyncFunction("updateLiveActivity") { (d: [String: Any], staleAt: Double) async -> Bool in
      guard let activity = Activity<BuddyActivityAttributes>.activities.first else { return false }
      await activity.update(self.content(d, staleAt: staleAt))
      return true
    }

    AsyncFunction("endLiveActivity") { () async in
      for activity in Activity<BuddyActivityAttributes>.activities {
        await activity.end(nil, dismissalPolicy: .immediate)
      }
    }

    Function("setShortcutState") { (json: String) in
      UserDefaults.standard.set(json, forKey: BuddyNativeModule.shortcutStateKey)
    }

    Function("beginBackgroundTask") { (name: String) -> Int in
      self.beginBackgroundTask(named: name)
    }

    Function("endBackgroundTask") { (id: Int) in
      self.finishBackgroundTask(id)
    }
  }
}
