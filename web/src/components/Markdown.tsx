import type { ReactNode } from 'react';

// Minimal Markdown for AI-written reports: headings, bullet / numbered lists, paragraphs, **bold**.
// Renders React elements only (no HTML injection).

function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') && part.length > 4 ? (
      <strong key={i} className="font-semibold text-zinc-900">
        {part.slice(2, -2)}
      </strong>
    ) : (
      part
    ),
  );
}

export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let para: string[] = [];

  const flush = () => {
    if (para.length) {
      blocks.push(
        <p key={blocks.length} className="text-sm leading-relaxed text-zinc-700">
          {inline(para.join(' '))}
        </p>,
      );
      para = [];
    }
    if (list) {
      const items = list.items.map((it, i) => (
        <li key={i} className="pl-1">
          {inline(it)}
        </li>
      ));
      blocks.push(
        list.ordered ? (
          <ol key={blocks.length} className="list-decimal space-y-1 pl-5 text-sm leading-relaxed text-zinc-700">
            {items}
          </ol>
        ) : (
          <ul key={blocks.length} className="list-disc space-y-1 pl-5 text-sm leading-relaxed text-zinc-700">
            {items}
          </ul>
        ),
      );
      list = null;
    }
  };

  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push(
        <h3 key={blocks.length} className="pt-2 text-base font-semibold text-zinc-900">
          {inline(heading[2])}
        </h3>,
      );
    } else if (bullet || numbered) {
      if (para.length) flush();
      const ordered = Boolean(numbered);
      if (list && list.ordered !== ordered) flush();
      list ??= { ordered, items: [] };
      list.items.push((bullet ?? numbered)![1]);
    } else if (!line.trim()) {
      flush();
    } else if (list && /^\s{2,}/.test(raw)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
    } else {
      if (list) flush();
      para.push(line.trim());
    }
  }
  flush();
  return <div className="space-y-3">{blocks}</div>;
}
