import ActivityKit
import Foundation

/// Live Activity data. The widget extension (targets/live-activity) declares the SAME type with the same
/// Codable shape: ActivityKit matches the app and the extension by type name and coding keys, so keep both
/// files identical when changing a field.
struct BuddyActivityAttributes: ActivityAttributes {
  struct ContentState: Codable, Hashable {
    var glucose: String
    var unit: String
    var arrow: String
    var delta: String
    var glucoseMgdl: Int
    var readingAt: Double
    var lastLoopAt: Double
    var iob: String
    var cob: String
    var low: Int
    var high: Int
    var stale: Bool
    var style: String
    var fontSize: String
    var showIob: Bool
    var showCob: Bool
    var showUpdated: Bool
    var chartAges: [Int]
    var chartValues: [Int]
  }

  var startedAt: Double
}
