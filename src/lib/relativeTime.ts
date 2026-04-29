export function relativeTime(input: string | number | Date, now = Date.now()): string {
  const t = new Date(input).getTime();
  const diffSec = Math.round((now - t) / 1000);
  if (diffSec < 5) return "just now";
  if (diffSec < 60) return `${diffSec} sec ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} min ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} hr ago`;
  if (diffSec < 86400 * 2) return "yesterday";
  if (diffSec < 86400 * 7) return `${Math.floor(diffSec / 86400)} days ago`;
  return new Date(input).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
