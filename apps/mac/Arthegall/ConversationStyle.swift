import SwiftUI

enum WorkspaceStyle {
    static let readingWidth: CGFloat = 780
    static let pine = Color(light: 0x236044, dark: 0x8BD1A7)
    static let canvas = Color(light: 0xFCFBF7, dark: 0x1D201E)
    static let sidebar = Color(light: 0xE8EEE7, dark: 0x212B25)
    static let surface = Color(light: 0xFFFFFF, dark: 0x292D2A)
    static let inset = Color(light: 0xF0F1EB, dark: 0x242924)
    static let hairline = Color.primary.opacity(0.13)
}

private extension Color {
    init(light: Int, dark: Int) {
        self.init(nsColor: NSColor(name: nil) { appearance in
            let rgb = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? dark : light
            return NSColor(srgbRed: CGFloat(rgb >> 16) / 255,
                           green: CGFloat((rgb >> 8) & 255) / 255,
                           blue: CGFloat(rgb & 255) / 255, alpha: 1)
        })
    }
}

struct ConversationAvatar: View {
    let dm: Conversation
    var user = false
    var size: CGFloat = 34

    private var color: Color {
        if user { return Color(red: 0.35, green: 0.38, blue: 0.42) }
        if dm.administrator == 1 { return Color(red: 0.13, green: 0.34, blue: 0.24) }
        let palette = [Color(red: 0.20, green: 0.38, blue: 0.46),
                       Color(red: 0.48, green: 0.30, blue: 0.29),
                       Color(red: 0.34, green: 0.31, blue: 0.52)]
        let index = dm.id.utf8.reduce(0) { ($0 + Int($1)) % palette.count }
        return palette[index]
    }

    var body: some View {
        ZStack {
            let shape = RoundedRectangle(cornerRadius: size * 0.28)
            shape.fill(color.gradient)
            shape.strokeBorder(.white.opacity(0.16), lineWidth: 1)
            if user || dm.administrator == 1 {
                Image(systemName: user ? "person.fill" : "shield.lefthalf.filled")
                    .font(.system(size: size * 0.49, weight: .medium))
            } else {
                Text(verbatim: String(dm.name.prefix(1)).uppercased())
                    .font(.system(size: size * 0.60, weight: .medium, design: .serif))
            }
        }
        .foregroundStyle(.white)
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

struct BrandIcon: View {
    let size: CGFloat

    var body: some View {
        Image(nsImage: NSApp.applicationIconImage)
            .resizable().interpolation(.high).frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

func copyText(_ text: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
}
