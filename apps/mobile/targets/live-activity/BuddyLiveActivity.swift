import ActivityKit
import SwiftUI
import WidgetKit

// Lock screen and Dynamic Island UI of Buddy's Live Activity (Trio LiveActivity/): glucose, trend arrow, delta,
// IOB, COB, last loop time and an optional mini chart. All data comes from the app (ContentState).

private enum Palette {
  static let low = Color(red: 1.0, green: 0.27, blue: 0.23)
  static let inRange = Color(red: 0.19, green: 0.82, blue: 0.35)
  static let high = Color(red: 0.75, green: 0.35, blue: 0.95)
  static let muted = Color.gray

  static func glucose(_ s: BuddyActivityAttributes.ContentState, stale: Bool) -> Color {
    if stale || s.glucoseMgdl == 0 { return muted }
    if s.glucoseMgdl < s.low { return low }
    if s.glucoseMgdl > s.high { return high }
    return inRange
  }
}

private extension BuddyActivityAttributes.ContentState {
  var readingDate: Date { Date(timeIntervalSince1970: readingAt) }
  var loopDate: Date { Date(timeIntervalSince1970: lastLoopAt) }
  var hasReading: Bool { readingAt > 0 }
  var glucoseSize: CGFloat {
    switch fontSize {
    case "small": return 28
    case "standard": return 40
    default: return 54
    }
  }
}

private struct GlucoseLine: View {
  let state: BuddyActivityAttributes.ContentState
  let stale: Bool
  var size: CGFloat

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 6) {
      Text(state.glucose)
        .font(.system(size: size, weight: .bold, design: .rounded))
        .foregroundStyle(Palette.glucose(state, stale: stale))
        .minimumScaleFactor(0.6)
      Text(state.arrow)
        .font(.system(size: size * 0.55, weight: .semibold))
        .foregroundStyle(Palette.glucose(state, stale: stale))
      if !state.delta.isEmpty {
        Text(state.delta)
          .font(.system(size: max(14, size * 0.38), weight: .medium, design: .rounded))
          .foregroundStyle(.secondary)
      }
    }
    .lineLimit(1)
  }
}

private struct Metric: View {
  let label: String
  let value: String
  var body: some View {
    VStack(alignment: .leading, spacing: 1) {
      Text(label).font(.caption2).foregroundStyle(.secondary)
      Text(value).font(.system(.subheadline, design: .rounded).weight(.semibold))
    }
  }
}

private struct Sparkline: View {
  let state: BuddyActivityAttributes.ContentState

  var body: some View {
    GeometryReader { geo in
      let values = state.chartValues
      let ages = state.chartAges
      if values.count >= 2, values.count == ages.count {
        let span = 180.0
        let lo = Double(min(values.min() ?? 70, state.low, 60)) - 10
        let hi = Double(max(values.max() ?? 180, state.high, 200)) + 10
        let y: (Double) -> CGFloat = { v in geo.size.height * (1 - CGFloat((v - lo) / (hi - lo))) }
        ZStack {
          Path { p in
            p.move(to: CGPoint(x: 0, y: y(Double(state.high))))
            p.addLine(to: CGPoint(x: geo.size.width, y: y(Double(state.high))))
            p.move(to: CGPoint(x: 0, y: y(Double(state.low))))
            p.addLine(to: CGPoint(x: geo.size.width, y: y(Double(state.low))))
          }
          .stroke(Color.secondary.opacity(0.35), style: StrokeStyle(lineWidth: 0.5, dash: [3, 3]))
          ForEach(Array(values.enumerated()), id: \.offset) { index, value in
            let x = geo.size.width * CGFloat(1 - Double(ages[index]) / span)
            Circle()
              .fill(value < state.low ? Palette.low : (value > state.high ? Palette.high : Palette.inRange))
              .frame(width: 4, height: 4)
              .position(x: x, y: y(Double(value)))
          }
        }
      }
    }
  }
}

private struct LockScreenView: View {
  let state: BuddyActivityAttributes.ContentState
  let stale: Bool

  var body: some View {
    if state.style == "detailed" {
      VStack(alignment: .leading, spacing: 8) {
        HStack(alignment: .firstTextBaseline) {
          GlucoseLine(state: state, stale: stale, size: 36)
          Spacer()
          if state.hasReading {
            Text(state.readingDate, style: .time).font(.caption).foregroundStyle(.secondary)
          }
        }
        HStack(spacing: 20) {
          if state.showIob { Metric(label: "IOB", value: "\(state.iob) U") }
          if state.showCob { Metric(label: "COB", value: "\(state.cob) g") }
          if state.showUpdated, state.lastLoopAt > 0 {
            VStack(alignment: .leading, spacing: 1) {
              Text("Loop").font(.caption2).foregroundStyle(.secondary)
              Text(state.loopDate, style: .time).font(.system(.subheadline, design: .rounded).weight(.semibold))
            }
          }
          Spacer(minLength: 0)
        }
        if !state.chartValues.isEmpty { Sparkline(state: state).frame(height: 56) }
      }
      .padding(14)
    } else {
      HStack(alignment: .center) {
        GlucoseLine(state: state, stale: stale, size: state.glucoseSize)
        Spacer()
        if state.hasReading {
          VStack(alignment: .trailing, spacing: 2) {
            Text(state.readingDate, style: .time).font(.subheadline.weight(.medium))
            Text(stale ? "Old" : state.unit).font(.caption).foregroundStyle(.secondary)
          }
        }
      }
      .padding(14)
    }
  }
}

struct BuddyLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: BuddyActivityAttributes.self) { context in
      LockScreenView(state: context.state, stale: context.isStale || context.state.stale)
        .activityBackgroundTint(Color.black.opacity(0.55))
        .activitySystemActionForegroundColor(.white)
    } dynamicIsland: { context in
      let state = context.state
      let stale = context.isStale || state.stale
      return DynamicIsland {
        DynamicIslandExpandedRegion(.leading) { GlucoseLine(state: state, stale: stale, size: 30) }
        DynamicIslandExpandedRegion(.trailing) {
          if state.hasReading { Text(state.readingDate, style: .time).font(.caption).foregroundStyle(.secondary) }
        }
        DynamicIslandExpandedRegion(.bottom) {
          HStack(spacing: 20) {
            Metric(label: "IOB", value: "\(state.iob) U")
            Metric(label: "COB", value: "\(state.cob) g")
            if state.lastLoopAt > 0 {
              VStack(alignment: .leading, spacing: 1) {
                Text("Loop").font(.caption2).foregroundStyle(.secondary)
                Text(state.loopDate, style: .time).font(.system(.subheadline, design: .rounded).weight(.semibold))
              }
            }
          }
        }
      } compactLeading: {
        Text("\(state.glucose)\(state.arrow)").font(.system(.caption, design: .rounded).weight(.bold)).foregroundStyle(Palette.glucose(state, stale: stale))
      } compactTrailing: {
        Text(state.delta).font(.system(.caption, design: .rounded)).foregroundStyle(.secondary)
      } minimal: {
        Text(state.glucose).font(.system(.caption2, design: .rounded).weight(.bold)).foregroundStyle(Palette.glucose(state, stale: stale))
      }
    }
  }
}
