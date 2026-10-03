// PROTOTYPE, throwaway. Just enough markdown for plan previews and the journal:
// headings, bullets, numbered lines, **bold**, `code`. The real build would use a library.
import type { ReactNode } from "react";

export function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    out.push(t.startsWith("**")
      ? <strong key={k++} className="font-semibold">{t.slice(2, -2)}</strong>
      : <code key={k++} className="rounded bg-surface-2 px-1 py-px font-mono text-[0.85em]">{t.slice(1, -1)}</code>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Md({ text }: { text: string }) {
  const blocks = text.split(/\n\n+/);
  return (
    <div className="flex flex-col gap-2.5 text-base leading-relaxed">
      {blocks.map((b, i) => {
        if (b.startsWith("# ")) return <h3 key={i} className="text-lg font-semibold">{inline(b.slice(2))}</h3>;
        if (b.startsWith("## ")) return <h4 key={i} className="text-base font-semibold">{inline(b.slice(3))}</h4>;
        const lines = b.split("\n");
        if (lines.every((l) => l.startsWith("- "))) {
          return <ul key={i} className="flex list-disc flex-col gap-1 pl-5 marker:text-faint">{lines.map((l, j) => <li key={j}>{inline(l.slice(2))}</li>)}</ul>;
        }
        return <p key={i}>{inline(b)}</p>;
      })}
    </div>
  );
}
