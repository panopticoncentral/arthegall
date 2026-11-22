import SwiftUI

struct ReportDetails: View {
    let id: String
    let source: String
    let evidence: Message.ReportEvidence
    @State private var showsUsage = false
    @State private var showsSource = false

    var body: some View {
        disclosure("Recorded usage · \(evidence.range.label)", expanded: $showsUsage)
            .accessibilityIdentifier("recorded-usage-" + id)
            .accessibilityHint("Shows the saved Codex and Claude coverage and counts for this report.")
        if showsUsage {
            VStack(alignment: .leading, spacing: 12) {
                Text("\(evidence.timeZone) · Local runner records").foregroundStyle(.secondary)
                usage("Codex", evidence.codex)
                usage("Claude", evidence.claude)
                Text("Combined tokens \(count(evidence.combinedTokens)) · Actual spend \(spend(evidence.combinedActualSpendUsd))")
            }
            .padding(.vertical, 6)
            .textSelection(.enabled)
        }
        disclosure("Original message text", expanded: $showsSource)
            .accessibilityIdentifier("original-message-" + id)
        if showsSource {
            Text(verbatim: source).font(.system(.body, design: .monospaced))
                .textSelection(.enabled)
                .accessibilityIdentifier("original-report-source")
        }
    }

    private func disclosure(_ title: String, expanded: Binding<Bool>) -> some View {
        Button {
            expanded.wrappedValue.toggle()
        } label: {
            Label(title, systemImage: expanded.wrappedValue ? "chevron.down" : "chevron.right")
        }
        .accessibilityValue(expanded.wrappedValue ? "Expanded" : "Collapsed")
    }

    private func usage(_ provider: String, _ source: Message.ReportEvidence.SourceUsage) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(provider).font(.headline).accessibilityAddTraits(.isHeader)
            Text("\(coverage(source.coverage)) · \(count(source.responses)) distinct responses found")
            Text("Input \(count(source.input)) (cached \(count(source.cachedInput))) · Output \(count(source.output)) (reasoning \(count(source.reasoningOutput))) · Total \(count(source.total))")
            Text("Actual spend \(spend(source.actualSpendUsd))")
            ForEach(Array(source.notes.enumerated()), id: \.offset) { _, note in
                if note != "Actual spend unavailable from these records." {
                    Text(verbatim: note).foregroundStyle(.secondary)
                }
            }
        }
    }

    private func coverage(_ value: String) -> String {
        switch value {
        case "recorded": "Recorded responses"
        case "partial": "Partial coverage"
        case "no_records": "No local records"
        default: "Coverage unknown"
        }
    }

    private func count(_ value: Int?) -> String { value?.formatted() ?? "Unknown" }
    private func spend(_ value: Double?) -> String {
        value.map { "\($0) USD" } ?? "Unavailable"
    }
}
