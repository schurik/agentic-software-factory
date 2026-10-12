/**
 * How an amount and a duration are said, on every page and in every reading
 * the model words itself (model/benchmarks.ts): one definition, so a
 * benchmark's "$0.80 less" says money the way its "$2.50 ± $0.71" does.
 * `components/format.ts` re-exports both beside the rest of the formats.
 */

const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** An amount in USD, zero included: what a roll-up or a ceiling says. "$1,234.50". */
export function formatDollars(value: number): string {
  return dollars.format(value);
}

/** How long something took, to the precision a person reads it at: "28s", "4m 34s", "58m", "2h 8m", "2d 5h". */
export function formatDuration(seconds: number | null): string {
  if (seconds === null) return "…";
  if (seconds < 1) return "<1s";
  const whole = Math.round(seconds);
  if (whole < 60) return `${whole}s`;
  const minutes = Math.floor(whole / 60);
  if (whole < 600) return `${minutes}m ${String(whole % 60).padStart(2, "0")}s`;
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}
