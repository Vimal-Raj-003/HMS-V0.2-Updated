/** `HH:mm:ss` in the device's local zone — the only format a waiting room reads. */
export function formatClockTime(at: Date): string {
  const hh = String(at.getHours()).padStart(2, '0');
  const mm = String(at.getMinutes()).padStart(2, '0');
  const ss = String(at.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/** `HH:mm` — used in the staleness chip, where seconds are noise. */
export function formatClockMinutes(at: Date): string {
  const hh = String(at.getHours()).padStart(2, '0');
  const mm = String(at.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/**
 * `Mon 19 Aug` without `Intl`: an Android TV box may ship a stripped ICU, and a
 * board that throws on a date format is a black screen in a corridor.
 */
export function formatBoardDate(at: Date): string {
  const weekday = WEEKDAYS[at.getDay()] ?? '';
  const month = MONTHS[at.getMonth()] ?? '';
  return `${weekday} ${String(at.getDate()).padStart(2, '0')} ${month}`;
}

/** "4 s" / "2 min" / "1 h 05 min" — how old the data on screen is. */
export function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${String(minutes % 60).padStart(2, '0')} min`;
}
