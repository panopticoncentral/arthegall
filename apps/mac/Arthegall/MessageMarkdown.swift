import SwiftUI

/// Foundation parses Markdown into semantic runs. Lay out the block intents here
/// so lists, code and report columns retain their structure in a SwiftUI transcript.
struct MessageMarkdown: View, Equatable {
    let source: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Self.blocks(source)) { block in
                HStack(alignment: .firstTextBaseline, spacing: 7) {
                    if let marker = block.marker {
                        Text(verbatim: marker).foregroundStyle(.secondary).monospacedDigit()
                    }
                    content(block)
                }
                .padding(.leading, CGFloat(block.indent) * 13 + (block.quoted ? 11 : 0))
                .overlay(alignment: .leading) {
                    if block.quoted { Capsule().fill(WorkspaceStyle.pine.opacity(0.45)).frame(width: 2) }
                }
            }
        }
        .font(.system(size: 14)).lineSpacing(3)
        .textSelection(.enabled)
        .tint(WorkspaceStyle.pine)
    }

    @ViewBuilder private func content(_ block: Block) -> some View {
        switch block.kind {
        case .header(let level):
            Text(block.text)
                .font(.system(size: level == 1 ? 24 : level == 2 ? 21 : 16, weight: .semibold,
                              design: level <= 2 ? .serif : .default))
                .padding(.top, 3).accessibilityAddTraits(.isHeader)
        case .codeBlock(let language):
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Label(language.flatMap { $0.isEmpty ? nil : $0 } ?? "Code", systemImage: "chevron.left.forwardslash.chevron.right")
                    Spacer()
                    Button { copyText(String(block.text.characters)) } label: {
                        Image(systemName: "doc.on.doc")
                    }
                    .buttonStyle(.borderless).accessibilityLabel("Copy code").help("Copy code")
                }
                .font(.caption).foregroundStyle(.secondary).padding(.horizontal, 11).padding(.vertical, 6)
                Divider()
                ScrollView(.horizontal) {
                    let code = String(block.text.characters)
                    Text(verbatim: code.hasSuffix("\n") ? String(code.dropLast()) : code)
                        .font(.system(size: 12, design: .monospaced)).fixedSize()
                        .padding(11)
                }
            }
            .background(WorkspaceStyle.inset, in: RoundedRectangle(cornerRadius: 7))
        case .table(let columns):
            ViewThatFits(in: .horizontal) {
                table(block.rows, columns: columns).fixedSize(horizontal: true, vertical: false)
                ScrollView(.horizontal) { table(block.rows, columns: columns) }
            }
        case .thematicBreak:
            Divider()
        default:
            Text(block.text).fixedSize(horizontal: false, vertical: true)
        }
    }

    private func table(_ rows: [Row], columns: [PresentationIntent.TableColumn]) -> some View {
        Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
            ForEach(rows) { row in
                GridRow {
                    ForEach(columns.indices, id: \.self) { index in
                        Text(row.cells[index] ?? AttributedString(" "))
                            .font(.system(size: 12, weight: row.header ? .semibold : .regular))
                            .padding(.horizontal, 10).padding(.vertical, 6)
                            .gridColumnAlignment(alignment(columns[index].alignment))
                    }
                }
                .background(row.header ? WorkspaceStyle.inset : WorkspaceStyle.surface)
                Divider().gridCellUnsizedAxes(.horizontal)
            }
        }
        .background(WorkspaceStyle.surface)
        .accessibilityElement(children: .contain)
        .clipShape(RoundedRectangle(cornerRadius: 7))
        .overlay { RoundedRectangle(cornerRadius: 7).strokeBorder(WorkspaceStyle.hairline) }
    }

    private func alignment(_ alignment: PresentationIntent.TableColumn.Alignment) -> HorizontalAlignment {
        switch alignment {
        case .right: .trailing
        case .center: .center
        default: .leading
        }
    }

    private struct Row: Identifiable {
        let id: Int
        let header: Bool
        var cells: [Int: AttributedString] = [:]
    }

    private struct Block: Identifiable {
        let id: Int
        let kind: PresentationIntent.Kind
        var text = AttributedString()
        var marker: String?
        var indent = 0
        var quoted = false
        var rows: [Row] = []
    }

    static func parsedSource(_ source: String) -> AttributedString {
        guard var parsed = try? AttributedString(markdown: source,
            options: .init(allowsExtendedAttributes: false, failurePolicy: .returnPartiallyParsedIfPossible)),
            !parsed.characters.isEmpty else {
            return AttributedString(source)
        }
        // Display image descriptions locally and only activate ordinary web/mail links.
        for run in parsed.runs {
            if let url = run.link, !["https", "http", "mailto"].contains(url.scheme?.lowercased() ?? "") {
                parsed[run.range].link = nil
            }
            if run.imageURL != nil { parsed[run.range].imageURL = nil }
        }

        return parsed
    }

    private static func blocks(_ source: String) -> [Block] {
        let parsed = parsedSource(source)
        if parsed.characters.isEmpty { return [Block(id: 0, kind: .paragraph, text: parsed)] }
        var result: [Block] = []
        var renderedItems = Set<Int>()
        for (intent, range) in parsed.runs[\.presentationIntent] {
            let parts = intent?.components ?? []
            var text = AttributedString(parsed[range])
            text.presentationIntent = nil
            if let leaf = parts.first, case .tableCell(let column) = leaf.kind,
               parts.count >= 3, case .table = parts[2].kind {
                let row = parts[1], table = parts[2]
                if result.last?.id != table.identity {
                    result.append(Block(id: table.identity, kind: table.kind))
                }
                let i = result.count - 1
                if result[i].rows.last?.id != row.identity {
                    result[i].rows.append(Row(id: row.identity, header: row.kind == .tableHeaderRow))
                }
                let j = result[i].rows.count - 1
                result[i].rows[j].cells[column] = text
            } else {
                var block = Block(id: parts.first?.identity ?? -(result.count + 1),
                                  kind: parts.first?.kind ?? .paragraph, text: text)
                block.quoted = parts.contains { $0.kind == .blockQuote }
                let lists = parts.filter { $0.kind == .orderedList || $0.kind == .unorderedList }
                block.indent = max(0, lists.count - 1)
                if let item = parts.first(where: { if case .listItem = $0.kind { true } else { false } }),
                   case .listItem(let number) = item.kind {
                    if renderedItems.insert(item.identity).inserted {
                        block.marker = lists.first?.kind == .orderedList ? "\(number)." : "•"
                    } else {
                        block.indent += 1
                    }
                }
                result.append(block)
            }
        }
        return result
    }
}
