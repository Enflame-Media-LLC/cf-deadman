export function formatDueAt(value: string | null, timeZone?: string): string {
  if (!value) return "No deadline scheduled";
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(new Date(value));
}
