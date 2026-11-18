import { Fragment, memo } from "react";

function inline(text: string) {
  return text
    .split(/(`[^`\n]+`)/g)
    .map((part, index) =>
      part.startsWith("`") && part.endsWith("`") ? (
        <code key={index}>{part.slice(1, -1)}</code>
      ) : (
        <Fragment key={index}>{part}</Fragment>
      ),
    );
}

// Deliberately small text renderer. React escapes every node; no raw HTML,
// automatic links, remote images or Markdown plugins can execute model output.
export const MessageContent = memo(function MessageContent({ content }: { content: string }) {
  const blocks: React.ReactNode[] = [];
  const lines = content.split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.startsWith("```")) {
      const code: string[] = [];
      index++;
      while (index < lines.length && !lines[index]!.startsWith("```")) code.push(lines[index++]!);
      if (index < lines.length) index++;
      blocks.push(
        <pre key={blocks.length}>
          <code>{code.join("\n")}</code>
        </pre>,
      );
    } else if (/^#{1,3}\s/.test(line)) {
      blocks.push(<h3 key={blocks.length}>{inline(line.replace(/^#{1,3}\s+/, ""))}</h3>);
      index++;
    } else if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: React.ReactNode[] = [];
      const pattern = ordered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/;
      while (index < lines.length && pattern.test(lines[index]!)) {
        items.push(<li key={items.length}>{inline(lines[index++]!.replace(pattern, ""))}</li>);
      }
      blocks.push(
        ordered ? <ol key={blocks.length}>{items}</ol> : <ul key={blocks.length}>{items}</ul>,
      );
    } else {
      const paragraph: string[] = [line];
      index++;
      while (
        index < lines.length &&
        lines[index] &&
        !/^(```|#{1,3}\s|\s*([-*]|\d+\.)\s+)/.test(lines[index]!)
      )
        paragraph.push(lines[index++]!);
      blocks.push(<p key={blocks.length}>{inline(paragraph.join("\n"))}</p>);
    }
  }
  return <div className="chat-prose">{blocks}</div>;
});
