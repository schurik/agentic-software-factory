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

  /** A number, or null where there is none: for a field whose absence is an answer. */
  numOrNull(key: string): number | null {
    const value = this.raw[key];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  bool(key: string): boolean {
    return this.raw[key] === true;
  }

  obj(key: string): Payload | null {
    const value = this.raw[key];
    return isRecord(value) ? new Payload(value) : null;
  }

  /** The payload as it arrived. */
  value(): Record<string, unknown> {
    return this.raw;
  }

  /** The objects in a list, skipping whatever is not one. */
  list(key: string): Payload[] {
    const value = this.raw[key];
    return Array.isArray(value) ? value.filter(isRecord).map((each) => new Payload(each)) : [];
  }

  /** The strings in a list, skipping whatever is not one. */
  strs(key: string): string[] {
    const value = this.raw[key];
    return Array.isArray(value) ? value.filter((each): each is string => typeof each === "string") : [];
  }

  /** The finite numbers in a list, skipping whatever is not one. */
  nums(key: string): number[] {
    const value = this.raw[key];
    return Array.isArray(value)
      ? value.filter((each): each is number => typeof each === "number" && Number.isFinite(each))
      : [];
  }
}
