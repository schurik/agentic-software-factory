// PROTOTYPE, throwaway. Markdown through react-markdown + GFM (task lists, tables,
// strikethrough) + hard line breaks — journal.py writes a note under its phase on the next
// line, and that line break carries meaning. Styled by `.md` in globals.css.
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { cx } from "./ui";

export function Md({ text, className, size = "base" }: { text: string; className?: string; size?: "sm" | "base" }) {
  return (
    <div className={cx("md", size === "sm" && "md-sm", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{ a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" /> }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
