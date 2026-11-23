// Journal bodies are already encoded JSON. Measure the actual wire envelope,
// including delimiters, before materializing the batch.
export function replayBatch(rows, limit) {
  const prefix = '{"op":"events","rows":[';
  const suffix = "]}";
  const encoded = [];
  let lastSeq;
  let bytes = prefix.length + suffix.length;
  for (const { seq, body } of rows) {
    const header = '{"seq":' + seq + ',"event":';
    const bodyBytes = Buffer.byteLength(body);
    bytes += (encoded.length ? 1 : 0) + header.length + bodyBytes + 1;
    if (bytes > limit) {
      if (encoded.length) break;
      return {
        lastSeq: seq,
        message: JSON.stringify({ op: "eventStart", seq, bytes: bodyBytes }),
        body: Buffer.from(body),
      };
    }
    lastSeq = seq;
    encoded.push(header + body + "}");
  }
  if (encoded.length)
    return { lastSeq, message: prefix + encoded.join(",") + suffix };
}
