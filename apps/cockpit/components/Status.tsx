export function Status({ status }: { status: string }) {
  return <span className={`status status-${status}`}>{status}</span>;
}
