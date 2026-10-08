import { describe, expect, it } from "vitest";
import { treeOf } from "../components/factory/tree";

// The config editor's file list as a tree (#157): the files under `asf/` grouped
// by folder, as a file explorer shows them — folders first, then files, each
// level in name order.

describe("the editor's file tree", () => {
  it("groups the files under asf/ by folder, folders before files, each in name order", () => {
    expect(treeOf([
      "asf/workflows/sdlc/workflow.yaml",
      "asf/factory.yaml",
      "asf/agents/planner/agent.md",
      "asf/workflows/sdlc/tasks/plan.md",
      "asf/agents/builder/agent.md",
      "asf/env.sample",
      "asf/workflows/issue/workflow.yaml",
    ])).toEqual([
      { kind: "folder", name: "agents", path: "asf/agents", children: [
        { kind: "folder", name: "builder", path: "asf/agents/builder", children: [
          { kind: "file", name: "agent.md", path: "asf/agents/builder/agent.md" },
        ] },
        { kind: "folder", name: "planner", path: "asf/agents/planner", children: [
          { kind: "file", name: "agent.md", path: "asf/agents/planner/agent.md" },
        ] },
      ] },
      { kind: "folder", name: "workflows", path: "asf/workflows", children: [
        { kind: "folder", name: "issue", path: "asf/workflows/issue", children: [
          { kind: "file", name: "workflow.yaml", path: "asf/workflows/issue/workflow.yaml" },
        ] },
        { kind: "folder", name: "sdlc", path: "asf/workflows/sdlc", children: [
          { kind: "folder", name: "tasks", path: "asf/workflows/sdlc/tasks", children: [
            { kind: "file", name: "plan.md", path: "asf/workflows/sdlc/tasks/plan.md" },
          ] },
          { kind: "file", name: "workflow.yaml", path: "asf/workflows/sdlc/workflow.yaml" },
        ] },
      ] },
      { kind: "file", name: "env.sample", path: "asf/env.sample" },
      { kind: "file", name: "factory.yaml", path: "asf/factory.yaml" },
    ]);
  });

  it("is empty with no file", () => {
    expect(treeOf([])).toEqual([]);
  });
});
