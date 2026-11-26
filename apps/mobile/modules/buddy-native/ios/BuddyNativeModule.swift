import ActivityKit
import ExpoModulesCore
import Foundation

/// iOS side of the native services:
///  - Live Activity start/update/end (ActivityKit). The UI lives in the widget extension target.
///  - `setShortcutState`: stores a JSON snapshot in UserDefaults for the App Intents (Get State, bolus switch).
public class BuddyNativeModule: Module {
  private static let shortcutStateKey = "buddy.shortcutState.v1"

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
  }
}
