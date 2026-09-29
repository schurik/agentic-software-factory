export function sessionHref(factory: string, session: string): string {
  return `/sessions/${factory.split("/").map(encodeURIComponent).join("/")}/${encodeURIComponent(session)}`;
}

export function cost(value: number): string {
  return value ? `$${value.toFixed(2)}` : "—";
}

export function when(ts: string): string {
  if (!ts) return "—";
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? ts : date.toLocaleString();
}
