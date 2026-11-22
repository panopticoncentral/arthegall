import Foundation

@main struct MacMarkdownProbe {
    static func main() {
        let parsed = MessageMarkdown.parsedSource("""
        ## Source coverage

        - Open the [collection guide](https://example.org/guide).
        - Treat [unsupported destination](data:text/plain,example) as text.

        <mark>literal markup</mark>

        ![diagram description](https://example.org/diagram.png)
        """)
        let links = parsed.runs.compactMap { $0.link?.absoluteString }
        precondition(links == ["https://example.org/guide"], "Only the supported destination should be linked")
        precondition(parsed.runs.allSatisfy { $0.imageURL == nil }, "Transcript Markdown must not load remote images")
        let text = String(parsed.characters)
        for phrase in ["Source coverage", "collection guide", "unsupported destination", "literal markup", "diagram description"] {
            precondition(text.contains(phrase), "Transcript Markdown should preserve \(phrase)")
        }
        print("Verified native Markdown keeps ordinary links, renders other labels as text, and avoids remote images.")
    }
}
