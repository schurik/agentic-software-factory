import { isRecord } from "./wire";

/**
 * A payload read defensively. The factory validates what it writes, but a
 * reader that threw on a malformed event would wedge ingest for that session
 * forever — the station resends the same batch — so a missing or mistyped
 * field reads as empty instead.
 */
export class Payload {
  constructor(private readonly raw: Record<string, unknown>) {}

  static parse(text: string): Payload {
    try {
      const value: unknown = JSON.parse(text);
      return new Payload(isRecord(value) ? value : {});
    } catch {
      return new Payload({});
    }
  }

  str(key: string): string {
    const value = this.raw[key];
    return typeof value === "string" ? value : "";
  }

  num(key: string): number {
    const value = this.raw[key];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  }

  bool(key: string): boolean {
    return this.raw[key] === true;
  }

  obj(key: string): Payload | null {
    const value = this.raw[key];
    return isRecord(value) ? new Payload(value) : null;
  }

  /** The strings in a list, skipping whatever is not one. */
  strs(key: string): string[] {
    const value = this.raw[key];
    return Array.isArray(value) ? value.filter((each): each is string => typeof each === "string") : [];
  }
}
