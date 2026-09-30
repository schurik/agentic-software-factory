/** SHA-256 of `text`, hex. What a token is stored and looked up as. */
export async function digest(text: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
}

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A fresh secret, to be handed over once and kept only as its digest. Call it
 * from an action: a mutation's randomness is seeded so it can be replayed, and
 * a secret must not be reproducible.
 */
export function secret(prefix: string): string {
  return prefix + hex(crypto.getRandomValues(new Uint8Array(32)));
}
