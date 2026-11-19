import { memo } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

function safeDestination(value: string) {
  const url = URL.parse(value, document.baseURI);
  return url && ['https:', 'http:', 'mailto:'].includes(url.protocol) ? url.href : undefined;
}

// Render Markdown as React elements. Raw HTML stays text and images never fetch.
export const MessageMarkdown = memo(function MessageMarkdown({ text }: { text: string }) {
  return <div className="message-text markdown">
    <Markdown remarkPlugins={[remarkGfm]} urlTransform={safeDestination} components={{
      a: ({ href, children }) => href ? <a href={href}>{children}</a> : <>{children}</>,
      img: ({ alt }) => <>{alt}</>,
      table: ({ children }) => <div className="table-scroll"><table>{children}</table></div>,
    }}>{text}</Markdown>
  </div>;
});
