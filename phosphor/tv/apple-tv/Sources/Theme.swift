import SwiftUI

// MARK: - Phosphor retro-terminal / CRT theme
//
// Original design direction: green phosphor text glowing on a near-black
// screen, monospaced type only, faint scanlines and a CRT vignette. No
// bundled fonts, no external assets — everything here is drawn with system
// SwiftUI primitives.

extension Color {
    /// The signature "P1 phosphor" green.
    static let phosphorGreen = Color(red: 0.2, green: 1.0, blue: 0.4)
    /// Dimmer green for secondary / muted text.
    static let phosphorDim = Color(red: 0.2, green: 1.0, blue: 0.4).opacity(0.55)
    /// Near-black CRT background — not pure black, a touch of green in the shadows.
    static let terminalBackground = Color(red: 0.02, green: 0.035, blue: 0.02)
    static let terminalPanelBackground = Color(red: 0.05, green: 0.08, blue: 0.05)
    /// Reserved for error text — a warm red cuts through the monochrome green.
    static let terminalError = Color(red: 1.0, green: 0.27, blue: 0.27)
    /// Reserved for warnings / in-progress states.
    static let terminalAmber = Color(red: 1.0, green: 0.78, blue: 0.2)
}

extension Font {
    /// Monospaced-only type, per the terminal design language.
    static func phosphor(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .monospaced)
    }
}

/// A soft two-layer glow behind phosphor-green text/graphics, mimicking a CRT's
/// light bloom.
struct PhosphorGlow: ViewModifier {
    var radius: CGFloat = 10
    var color: Color = .phosphorGreen

    func body(content: Content) -> some View {
        content
            .shadow(color: color.opacity(0.85), radius: radius * 0.3)
            .shadow(color: color.opacity(0.45), radius: radius)
    }
}

extension View {
    func phosphorGlow(radius: CGFloat = 10, color: Color = .phosphorGreen) -> some View {
        modifier(PhosphorGlow(radius: radius, color: color))
    }
}

/// A faint repeating scanline overlay. Deliberately subtle — this is meant to
/// read as texture, not to fight with legibility.
struct ScanlineOverlay: View {
    var spacing: CGFloat = 3
    var lineOpacity: Double = 0.08

    var body: some View {
        Canvas { context, size in
            var y: CGFloat = 0
            while y < size.height {
                context.fill(Path(CGRect(x: 0, y: y, width: size.width, height: 1)),
                              with: .color(.black.opacity(lineOpacity)))
                y += spacing
            }
        }
        .allowsHitTesting(false)
    }
}

/// Soft dark corners, like light falloff on a curved CRT tube.
struct CRTVignette: View {
    var body: some View {
        RadialGradient(
            gradient: Gradient(colors: [Color.clear, Color.black.opacity(0.55)]),
            center: .center,
            startRadius: 340,
            endRadius: 980
        )
        .allowsHitTesting(false)
    }
}

/// Wraps a screen's content in the standard Phosphor backdrop: near-black
/// background, scanlines, vignette. Every top-level screen uses this.
struct CRTBackground<Content: View>: View {
    let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        ZStack {
            Color.terminalBackground.ignoresSafeArea()
            content
            ScanlineOverlay().ignoresSafeArea()
            CRTVignette().ignoresSafeArea()
        }
    }
}

/// Big, chunky, uppercase, glowing — the standard screen/section title.
struct TerminalTitle: View {
    let text: String
    var size: CGFloat = 44

    var body: some View {
        Text(text.uppercased())
            .font(.phosphor(size, weight: .black))
            .foregroundStyle(Color.phosphorGreen)
            .phosphorGlow()
    }
}

/// A bordered "panel" container with an ASCII-flavored title rule, used to
/// group related controls (server settings, login form, filters, ...).
struct TerminalPanel<Content: View>: View {
    var title: String?
    let content: Content

    init(title: String? = nil, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            if let title {
                Text("── \(title.uppercased()) ──")
                    .font(.phosphor(16, weight: .bold))
                    .foregroundStyle(Color.phosphorGreen)
            }
            content
        }
        .padding(24)
        .background(Color.terminalPanelBackground.opacity(0.6))
        .overlay(
            RoundedRectangle(cornerRadius: 6)
                .stroke(Color.phosphorGreen.opacity(0.5), lineWidth: 1)
        )
    }
}

/// A "> " prompt-style text field, green-on-black with a hairline border.
struct TerminalField: View {
    let placeholder: String
    @Binding var text: String
    var isSecure: Bool = false

    var body: some View {
        HStack(spacing: 12) {
            Text(">")
                .font(.phosphor(20, weight: .bold))
                .foregroundStyle(Color.phosphorGreen)
            Group {
                if isSecure {
                    SecureField(placeholder, text: $text)
                } else {
                    TextField(placeholder, text: $text)
                        .textInputAutocapitalization(.never)
                }
            }
            .font(.phosphor(20))
            .foregroundStyle(Color.phosphorGreen)
        }
        .padding(.vertical, 14)
        .padding(.horizontal, 18)
        .background(Color.black.opacity(0.4))
        .overlay(
            RoundedRectangle(cornerRadius: 4)
                .stroke(Color.phosphorGreen.opacity(0.6), lineWidth: 1)
        )
    }
}

/// Focus-reactive label for `TerminalButton`. Reading `@Environment(\.isFocused)`
/// inside an ordinary View (rather than a custom `ButtonStyle`) is the safe,
/// well-documented way to react to tvOS focus state.
private struct TerminalButtonLabel: View {
    let title: String
    var isDestructive: Bool = false
    @Environment(\.isFocused) private var isFocused
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        let tint = isDestructive ? Color.terminalError : Color.phosphorGreen
        Text(title.uppercased())
            .font(.phosphor(18, weight: .bold))
            .padding(.horizontal, 26)
            .padding(.vertical, 12)
            .foregroundStyle(isFocused ? Color.black : tint)
            .opacity(isEnabled ? 1.0 : 0.4)
            .background(
                RoundedRectangle(cornerRadius: 4)
                    .fill(isFocused ? tint : Color.black.opacity(0.4))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 4)
                    .stroke(tint, lineWidth: isFocused ? 2 : 1)
            )
            .shadow(color: tint.opacity(isFocused ? 0.85 : 0), radius: 14)
            .scaleEffect(isFocused ? 1.05 : 1.0)
            .animation(.easeOut(duration: 0.15), value: isFocused)
    }
}

/// The standard action button: uppercase, monospaced, bordered, glows and
/// fills solid when focused. Used everywhere instead of the default tvOS
/// button chrome so the whole app reads as one terminal.
struct TerminalButton: View {
    let title: String
    var isDestructive: Bool = false
    let action: () -> Void

    init(_ title: String, isDestructive: Bool = false, action: @escaping () -> Void) {
        self.title = title
        self.isDestructive = isDestructive
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            TerminalButtonLabel(title: title, isDestructive: isDestructive)
        }
        .buttonStyle(.plain)
    }
}

/// One option in a `ChipToggle` row.
struct ChipOption<T: Hashable>: Identifiable {
    let value: T
    let label: String
    var id: T { value }

    init(_ value: T, _ label: String) {
        self.value = value
        self.label = label
    }
}

/// A row of mutually-exclusive text "chips" — a terminal-flavored substitute
/// for `Picker`'s segmented style, which isn't available on tvOS.
struct ChipToggle<T: Hashable>: View {
    let options: [ChipOption<T>]
    @Binding var selection: T

    var body: some View {
        HStack(spacing: 0) {
            ForEach(options) { opt in
                Button {
                    selection = opt.value
                } label: {
                    Text(opt.label)
                        .font(.phosphor(15, weight: .bold))
                        .padding(.vertical, 10)
                        .padding(.horizontal, 18)
                        .foregroundStyle(selection == opt.value ? Color.black : Color.phosphorGreen)
                        .background(selection == opt.value ? Color.phosphorGreen : Color.clear)
                }
                .buttonStyle(.plain)
            }
        }
        .overlay(RoundedRectangle(cornerRadius: 4).stroke(Color.phosphorGreen, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 4))
    }
}

/// Status pill used on download queue rows.
struct StatusBadge: View {
    let status: String

    private var color: Color {
        switch status {
        case "finished": return .phosphorGreen
        case "error": return .terminalError
        case "downloading": return .terminalAmber
        default: return .phosphorDim // "queued"
        }
    }

    var body: some View {
        Text("[ \(status.uppercased()) ]")
            .font(.phosphor(15, weight: .bold))
            .foregroundStyle(color)
    }
}
