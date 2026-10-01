/**
 * The forge an action talks to: whichever credential this deployment holds,
 * behind the one interface (`forge.ts`).
 */
import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import { localHost, localToken, mode } from "../model/mode";
import { appForge } from "./app";
import type { Forge } from "./forge";
import { ForgeError, GitHub, Memory, RateLimited } from "./github";
import { tokenForge } from "./token";

export interface Opened {
  forge: Forge;
  /** Keep what this action learned of the forge. Call it whatever happened: a poll that failed half way still read what it read. */
  close(): Promise<void>;
}

export interface Asking {
  /** The share of the rate limit these calls leave alone (github.ts). */
  reserve?: number;
  /** In team mode, the user access token of the person the forge acts for. */
  user?: string;
}

/** The forge, or null when this deployment holds no credential for one yet. */
export async function open(ctx: ActionCtx, { reserve = 0, user }: Asking = {}): Promise<Opened | null> {
  const local = mode() === "local";
  if (local && !localToken()) return null;
  const held = await ctx.runQuery(internal.forge.memory.load, {});
  if (!local && held.app === null) return null;
  const memory = new Memory(
    new Map(held.answers.map(({ key, ...answer }) => [key, answer])),
    new Map(held.limits.map(({ scope, ...limit }) => [scope, limit])),
    new Map(held.tokens.map(({ installation, ...minted }) => [installation, minted])),
  );
  const github = new GitHub(local ? localHost() : held.app!.host, memory, reserve);
  return {
    forge: local ? tokenForge(github, localToken()) : appForge(github, held.app!, memory, user ?? null),
    close: async () => {
      await ctx.runMutation(internal.forge.memory.save, memory.learned());
    },
  };
}

/** What the forge said when it would not do something, as a refusal; anything else is thrown on. */
export function forgeSaid(error: unknown): { ok: false; because: string } {
  if (error instanceof ForgeError || error instanceof RateLimited) return { ok: false, because: error.message };
  throw error;
}

/** What a viewer is told of a factory the mirror does not let them read: no more than that it is not theirs to see. */
export const UNREADABLE = "no such factory among the ones you can read";
