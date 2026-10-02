/**
 * One factory, however it is spelled. The forge's names are case-insensitive
 * (`repoKey`), but what a station ships is stored under the name its ingest
 * token was issued for, in whatever case that was typed — and a page asks in
 * the case the forge spells it, or a person typed into the address bar.
 *
 * So a factory's data is stored under ONE spelling, chosen when its first
 * ingest token is issued (`spellingFor`) and kept by every token after, and a
 * function given a name from a page asks under that spelling (`storedAs`).
 */
import type { QueryCtx } from "./_generated/server";
import { repoKey } from "./forge/forge";

/** The spelling an ingest token's factory already has: any earlier token's, else the forge's, else as typed. */
export async function spellingFor(ctx: QueryCtx, factory: string): Promise<string> {
  const shipped = await shippedAs(ctx, factory);
  if (shipped !== null) return shipped;
  const repo = await ctx.db.query("repos").withIndex("by_key", (q) => q.eq("key", repoKey(factory))).unique();
  return repo?.name ?? factory;
}

/** The spelling `factory`'s data is stored under: as its stations ship it, else as given. */
export async function storedAs(ctx: QueryCtx, factory: string): Promise<string> {
  return (await shippedAs(ctx, factory)) ?? factory;
}

/**
 * Every spelling `factory`'s data may be stored under — the one it is, first,
 * then any a cockpit issued before it kept to one — for what is summed over
 * all of them, as spend is.
 */
export async function spellingsOf(ctx: QueryCtx, factory: string): Promise<string[]> {
  const key = repoKey(factory);
  const names = [await storedAs(ctx, factory)];
  for (const token of await ctx.db.query("ingestTokens").collect()) {
    if (repoKey(token.factory) === key && !names.includes(token.factory)) names.push(token.factory);
  }
  return names;
}

/**
 * The spelling the earliest ingest token for `factory` holds, or null when
 * none does. The table is a token a checkout, so it is read whole; a cockpit
 * that issued two spellings before this was kept to one reads the first.
 */
async function shippedAs(ctx: QueryCtx, factory: string): Promise<string | null> {
  const key = repoKey(factory);
  for (const token of await ctx.db.query("ingestTokens").collect()) {
    if (repoKey(token.factory) === key) return token.factory;
  }
  return null;
}
