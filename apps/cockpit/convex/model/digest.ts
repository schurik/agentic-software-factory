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

/**
 * The factory's `hitl.digest`: one SHA-256 over a gate's subject files, each
 * as its absolute path, a NUL, its bytes (or `<missing>`), a NUL — in the
 * order Python sorts the paths, which is part by part, not as strings
 * (`docs/asf/x` before `docs/asf-y`). What a decision names it decided on, so
 * the cockpit can say whether the files at a commit are the ones asked about.
 */
export async function subjectDigest(files: { absolute: string; bytes: Uint8Array | null }[]): Promise<string> {
  const parts = (path: string) => path.split("/");
  const sorted = [...files].sort((a, b) => compareParts(parts(a.absolute), parts(b.absolute)));
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const { absolute, bytes } of sorted) {
    chunks.push(encoder.encode(absolute), new Uint8Array([0]), bytes ?? encoder.encode("<missing>"), new Uint8Array([0]));
  }
  const whole = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    whole.set(chunk, at);
    at += chunk.length;
  }
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", whole)));
}

function compareParts(a: string[], b: string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return a.length - b.length;
}
