/**
 * The config editor's file list as a tree (#157): the files under `asf/`
 * grouped by folder, as a file explorer shows them — at each level the
 * folders first, then the files, each in name order.
 */
import { CONFIG_DIR } from "@/convex/model/config";

/** A folder, and what is in it; or a file. `path` is the whole path, `asf/` and all. */
export type TreeNode =
  | { kind: "folder"; name: string; path: string; children: TreeNode[] }
  | { kind: "file"; name: string; path: string };

/** `files`, every one under `asf/`, as the tree of what is under it. */
export function treeOf(files: string[]): TreeNode[] {
  const root: TreeNode[] = [];
  for (const path of files) {
    const parts = path.split("/").slice(1);
    let level = root;
    let at = CONFIG_DIR;
    for (const [index, name] of parts.entries()) {
      at = `${at}/${name}`;
      if (index === parts.length - 1) {
        level.push({ kind: "file", name, path });
        break;
      }
      let folder = level.find((node) => node.kind === "folder" && node.name === name);
      if (folder === undefined) {
        folder = { kind: "folder", name, path: at, children: [] };
        level.push(folder);
      }
      level = (folder as Extract<TreeNode, { kind: "folder" }>).children;
    }
  }
  return sorted(root);
}

function sorted(nodes: TreeNode[]): TreeNode[] {
  return nodes
    .map((node) => (node.kind === "folder" ? { ...node, children: sorted(node.children) } : node))
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "folder" ? -1 : 1));
}
