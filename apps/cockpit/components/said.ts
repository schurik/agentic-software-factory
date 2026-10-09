import { ConvexError } from "convex/values";

/** What went wrong, as the backend put it. */
export function said(error: unknown): string {
  if (error instanceof ConvexError && typeof error.data === "string") return error.data;
  return error instanceof Error ? error.message : String(error);
}
