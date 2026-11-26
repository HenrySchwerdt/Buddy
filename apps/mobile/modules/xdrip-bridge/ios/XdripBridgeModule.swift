import ExpoModulesCore
import Foundation

/// Reads what xDrip4iOS shares through the App Group, exactly like Trio's `AppGroupSource`:
/// suite name from the Info.plist key `AppGroupID` (written by the `with-xdrip` config plugin),
/// readings as JSON `Data` under the UserDefaults key `latestReadings`. Parsing happens in TypeScript.
public class XdripBridgeModule: Module {
  private static let readingsKey = "latestReadings"

  private var suiteName: String? {
    let raw = Bundle.main.object(forInfoDictionaryKey: "AppGroupID") as? String
    guard let id = raw?.trimmingCharacters(in: .whitespacesAndNewlines),
          !id.isEmpty,
          !id.contains("$("),   // unexpanded build setting
          !id.contains("XXXXXXXXXX") // plugin placeholder
    else { return nil }
    return id
  }

  public func definition() -> ModuleDefinition {
    Name("XdripBridge")

    /// True only when the group id is set AND the entitlement really grants access to it.
    AsyncFunction("isConfigured") { () -> Bool in
      guard let id = self.suiteName else { return false }
      return FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: id) != nil
    }

    AsyncFunction("getAppGroupId") { () -> String? in
      self.suiteName
    }

    /// Raw `latestReadings` bytes as a UTF-8 string, or nil when the group is not configured or xDrip4iOS shared nothing yet.
    AsyncFunction("readAppGroupJson") { () -> String? in
      guard let id = self.suiteName,
            let defaults = UserDefaults(suiteName: id),
            let data = defaults.data(forKey: Self.readingsKey)
      else { return nil }
      return String(data: data, encoding: .utf8)
    }
  }
}
