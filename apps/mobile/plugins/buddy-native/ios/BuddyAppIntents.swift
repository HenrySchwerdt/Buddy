import AppIntents
import Foundation
import UIKit

// Buddy App Intents (Trio `Shortcuts/*`): Bolus, Add Carbs, Meal Preset, Override and Temp Target presets,
// List State, Restart Live Activity.
//
// Safety contract: no intent delivers insulin or changes a setting by itself. Each one opens Buddy at
// `buddy://shortcut?action=...`, where the in-app confirmation screen (src/app/shortcut.tsx) shows the request and
// only its Confirm button acts, after the same safety checks as the bolus screen. Only "List State" runs without
// opening the app: it reads the JSON snapshot that the app keeps in UserDefaults (`setShortcutState`).
//
// This file is copied into the app target by plugins/with-buddy-native.js.

// MARK: - Shared state (written by modules/buddy-native `setShortcutState`)

private enum BuddyShared {
  static let key = "buddy.shortcutState.v1"

  static var state: [String: Any]? {
    guard let json = UserDefaults.standard.string(forKey: key),
          let data = json.data(using: .utf8),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return nil }
    return object
  }

  static func names(_ field: String) -> [String] {
    (state?[field] as? [String]) ?? []
  }

  static var allowBolus: Bool { (state?["allowBolus"] as? Bool) ?? false }
}

private enum BuddyLink {
  private static let unreserved: CharacterSet = {
    var set = CharacterSet.alphanumerics
    set.insert(charactersIn: "-._~")
    return set
  }()

  static func url(_ action: String, _ items: [(String, String)] = []) -> URL {
    let all = [("action", action)] + items
    let query = all.map { "\($0.0)=\($0.1.addingPercentEncoding(withAllowedCharacters: unreserved) ?? "")" }.joined(separator: "&")
    return URL(string: "buddy://shortcut?\(query)")!
  }

  @MainActor static func open(_ url: URL) async {
    _ = await UIApplication.shared.open(url)
  }
}

private enum BuddyIntentError: Error, CustomLocalizedStringResourceConvertible {
  case bolusDisabled
  case invalidAmount
  case noState

  var localizedStringResource: LocalizedStringResource {
    switch self {
    case .bolusDisabled: return "Bolus by Shortcuts is switched off. Turn it on in Buddy under Settings > Features > Shortcuts."
    case .invalidAmount: return "The amount must be greater than 0."
    case .noState: return "Buddy has no data yet. Open Buddy once and try again."
    }
  }
}

// MARK: - Preset entities (names come from the shared state)

struct BuddyOverridePreset: AppEntity {
  static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Override Preset")
  static var defaultQuery = BuddyOverridePresetQuery()
  var id: String
  var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(id)") }
}

struct BuddyOverridePresetQuery: EntityQuery {
  func entities(for identifiers: [String]) async throws -> [BuddyOverridePreset] { identifiers.map { BuddyOverridePreset(id: $0) } }
  func suggestedEntities() async throws -> [BuddyOverridePreset] { BuddyShared.names("overridePresets").map { BuddyOverridePreset(id: $0) } }
}

struct BuddyTempTargetPreset: AppEntity {
  static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Temp Target Preset")
  static var defaultQuery = BuddyTempTargetPresetQuery()
  var id: String
  var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(id)") }
}

struct BuddyTempTargetPresetQuery: EntityQuery {
  func entities(for identifiers: [String]) async throws -> [BuddyTempTargetPreset] { identifiers.map { BuddyTempTargetPreset(id: $0) } }
  func suggestedEntities() async throws -> [BuddyTempTargetPreset] { BuddyShared.names("tempTargetPresets").map { BuddyTempTargetPreset(id: $0) } }
}

struct BuddyMealPreset: AppEntity {
  static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Meal Preset")
  static var defaultQuery = BuddyMealPresetQuery()
  var id: String
  var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(id)") }
}

struct BuddyMealPresetQuery: EntityQuery {
  func entities(for identifiers: [String]) async throws -> [BuddyMealPreset] { identifiers.map { BuddyMealPreset(id: $0) } }
  func suggestedEntities() async throws -> [BuddyMealPreset] { BuddyShared.names("mealPresets").map { BuddyMealPreset(id: $0) } }
}

// MARK: - Intents

struct BuddyBolusIntent: AppIntent {
  static var title: LocalizedStringResource = "Enact Bolus"
  static var description = IntentDescription("Asks Buddy for a bolus. Buddy shows the amount and delivers it only after you confirm in the app.")
  static var openAppWhenRun: Bool = true

  @Parameter(title: "Amount (U)", description: "Bolus amount in units of insulin")
  var amount: Double

  static var parameterSummary: some ParameterSummary { Summary("Bolus \(\.$amount) U") }

  @MainActor func perform() async throws -> some IntentResult {
    guard BuddyShared.allowBolus else { throw BuddyIntentError.bolusDisabled }
    guard amount > 0, amount.isFinite else { throw BuddyIntentError.invalidAmount }
    await BuddyLink.open(BuddyLink.url("bolus", [("units", String(amount))]))
    return .result()
  }
}

struct BuddyAddCarbsIntent: AppIntent {
  static var title: LocalizedStringResource = "Add Carbs"
  static var description = IntentDescription("Asks Buddy to log carbs. Buddy asks you to confirm in the app.")
  static var openAppWhenRun: Bool = true

  @Parameter(title: "Carbs (g)") var carbs: Int
  @Parameter(title: "Fat (g)", default: 0) var fat: Int
  @Parameter(title: "Protein (g)", default: 0) var protein: Int
  @Parameter(title: "Note") var note: String?

  static var parameterSummary: some ParameterSummary { Summary("Add \(\.$carbs) g carbs") { \.$fat; \.$protein; \.$note } }

  @MainActor func perform() async throws -> some IntentResult {
    guard carbs > 0 else { throw BuddyIntentError.invalidAmount }
    var items: [(String, String)] = [("grams", String(carbs))]
    if fat > 0 { items.append(("fat", String(fat))) }
    if protein > 0 { items.append(("protein", String(protein))) }
    if let note, !note.isEmpty { items.append(("note", note)) }
    await BuddyLink.open(BuddyLink.url("carbs", items))
    return .result()
  }
}

struct BuddyAddMealPresetIntent: AppIntent {
  static var title: LocalizedStringResource = "Add Meal Preset"
  static var description = IntentDescription("Asks Buddy to log one of your meal presets. Buddy asks you to confirm in the app.")
  static var openAppWhenRun: Bool = true

  @Parameter(title: "Preset") var preset: BuddyMealPreset

  static var parameterSummary: some ParameterSummary { Summary("Add meal preset \(\.$preset)") }

  @MainActor func perform() async throws -> some IntentResult {
    await BuddyLink.open(BuddyLink.url("carb-preset", [("name", preset.id)]))
    return .result()
  }
}

struct BuddyApplyOverrideIntent: AppIntent {
  static var title: LocalizedStringResource = "Activate Override"
  static var description = IntentDescription("Asks Buddy to start an override preset. Buddy asks you to confirm in the app.")
  static var openAppWhenRun: Bool = true

  @Parameter(title: "Preset") var preset: BuddyOverridePreset

  static var parameterSummary: some ParameterSummary { Summary("Activate override \(\.$preset)") }

  @MainActor func perform() async throws -> some IntentResult {
    await BuddyLink.open(BuddyLink.url("override-apply", [("name", preset.id)]))
    return .result()
  }
}

struct BuddyCancelOverrideIntent: AppIntent {
  static var title: LocalizedStringResource = "Cancel Override"
  static var description = IntentDescription("Asks Buddy to stop the running override. Buddy asks you to confirm in the app.")
  static var openAppWhenRun: Bool = true

  @MainActor func perform() async throws -> some IntentResult {
    await BuddyLink.open(BuddyLink.url("override-cancel"))
    return .result()
  }
}

struct BuddyApplyTempTargetIntent: AppIntent {
  static var title: LocalizedStringResource = "Activate Temp Target"
  static var description = IntentDescription("Asks Buddy to start a temp target preset. Buddy asks you to confirm in the app.")
  static var openAppWhenRun: Bool = true

  @Parameter(title: "Preset") var preset: BuddyTempTargetPreset

  static var parameterSummary: some ParameterSummary { Summary("Activate temp target \(\.$preset)") }

  @MainActor func perform() async throws -> some IntentResult {
    await BuddyLink.open(BuddyLink.url("temp-target-apply", [("name", preset.id)]))
    return .result()
  }
}

struct BuddyCancelTempTargetIntent: AppIntent {
  static var title: LocalizedStringResource = "Cancel Temp Target"
  static var description = IntentDescription("Asks Buddy to stop the running temp target. Buddy asks you to confirm in the app.")
  static var openAppWhenRun: Bool = true

  @MainActor func perform() async throws -> some IntentResult {
    await BuddyLink.open(BuddyLink.url("temp-target-cancel"))
    return .result()
  }
}

struct BuddyRestartLiveActivityIntent: AppIntent {
  static var title: LocalizedStringResource = "Restart Live Activity"
  static var description = IntentDescription("Restarts the Buddy Live Activity (iOS needs the app open for this).")
  static var openAppWhenRun: Bool = true

  @MainActor func perform() async throws -> some IntentResult {
    await BuddyLink.open(BuddyLink.url("restart-live-activity"))
    return .result()
  }
}

struct BuddyListStateIntent: AppIntent {
  static var title: LocalizedStringResource = "List State"
  static var description = IntentDescription("Returns the last glucose, trend, delta, IOB and COB that Buddy knows. Does not open the app.")
  static var openAppWhenRun: Bool = false

  @MainActor func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
    guard let s = BuddyShared.state else { throw BuddyIntentError.noState }
    let unit = s["unit"] as? String ?? ""
    let readingAt = (s["readingAt"] as? NSNumber)?.doubleValue ?? 0
    var parts: [String] = []
    if readingAt > 0 {
      let time = Date(timeIntervalSince1970: readingAt).formatted(date: .omitted, time: .shortened)
      let glucose = "\(s["glucose"] as? String ?? "--") \(unit) \(s["arrow"] as? String ?? "") \(s["delta"] as? String ?? "")"
      parts.append("Glucose \(glucose.trimmingCharacters(in: .whitespaces)) at \(time)")
    } else {
      parts.append("No glucose reading")
    }
    parts.append("IOB \(s["iob"] as? String ?? "--") U")
    parts.append("COB \(s["cob"] as? String ?? "--") g")
    let text = parts.joined(separator: ", ")
    return .result(value: text, dialog: IntentDialog(stringLiteral: text))
  }
}

// MARK: - Shortcuts app tiles

struct BuddyAppShortcuts: AppShortcutsProvider {
  @AppShortcutsBuilder static var appShortcuts: [AppShortcut] {
    AppShortcut(intent: BuddyBolusIntent(), phrases: ["\(.applicationName) bolus", "Enact a \(.applicationName) bolus"], shortTitle: "Bolus", systemImageName: "syringe.fill")
    AppShortcut(intent: BuddyAddCarbsIntent(), phrases: ["Add carbs in \(.applicationName)", "\(.applicationName) add carbs"], shortTitle: "Add Carbs", systemImageName: "fork.knife")
    AppShortcut(intent: BuddyAddMealPresetIntent(), phrases: ["Add a \(.applicationName) meal preset"], shortTitle: "Meal Preset", systemImageName: "takeoutbag.and.cup.and.straw.fill")
    AppShortcut(intent: BuddyApplyOverrideIntent(), phrases: ["Activate \(.applicationName) override"], shortTitle: "Activate Override", systemImageName: "clock.arrow.2.circlepath")
    AppShortcut(intent: BuddyCancelOverrideIntent(), phrases: ["Cancel \(.applicationName) override"], shortTitle: "Cancel Override", systemImageName: "xmark.circle.fill")
    AppShortcut(intent: BuddyApplyTempTargetIntent(), phrases: ["Activate \(.applicationName) temporary target"], shortTitle: "Temp Target", systemImageName: "target")
    AppShortcut(intent: BuddyCancelTempTargetIntent(), phrases: ["Cancel \(.applicationName) temporary target"], shortTitle: "Cancel Temp Target", systemImageName: "xmark.circle")
    AppShortcut(intent: BuddyListStateIntent(), phrases: ["List \(.applicationName) state", "\(.applicationName) state"], shortTitle: "List State", systemImageName: "list.bullet")
    AppShortcut(intent: BuddyRestartLiveActivityIntent(), phrases: ["Restart \(.applicationName) Live Activity"], shortTitle: "Restart Live Activity", systemImageName: "arrow.clockwise.circle.fill")
  }
}
