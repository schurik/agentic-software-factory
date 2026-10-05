import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { cx } from "./ui";

/**
 * Markdown as a person reads it (#104): GitHub's flavour — tables, task
 * lists, strikethrough — with a line break kept where it was written, since
 * the factory's files put a note on the line under what it notes. Drawn by
 * `.md` in app/globals.css. Raw HTML in it is shown as text, never run, and
 * a link opens in a new tab: what an agent wrote is not this page.
 */
export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cx("md", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}
                     components={{ a: ({ href, title, children }) => <a href={href} title={title} target="_blank" rel="noreferrer">{children}</a> }}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

/** Whether a file is markdown, by its name. */
export const isMarkdown = (path: string): boolean => /\.(md|markdown)$/i.test(path);
