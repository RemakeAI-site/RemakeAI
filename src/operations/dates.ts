const dayMs = 86_400_000;
const partFormatters = new Map<string, Intl.DateTimeFormat>();

export function localDateParts(value: Date | string, timezone: string) {
  let formatter = partFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    partFormatters.set(timezone, formatter);
  }
  const parts = formatter.formatToParts(new Date(value));
  return Object.fromEntries(parts.map(({ type, value }) => [type, value]));
}

export function dateKey(value: Date | string, timezone: string) {
  const { year, month, day } = localDateParts(value, timezone);
  return `${year}-${month}-${day}`;
}

export function dateTimeInput(value: string, timezone: string) {
  const { year, month, day, hour, minute } = localDateParts(value, timezone);
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

export function zonedInputToISO(value: string, timezone: string) {
  const wallTime = Date.parse(`${value}:00Z`);
  if (!Number.isFinite(wallTime)) throw new Error("Укажите дату и время.");
  let candidate = wallTime;
  for (let attempt = 0; attempt < 4; attempt++) {
    const displayed = dateTimeInput(new Date(candidate).toISOString(), timezone);
    if (displayed === value) return new Date(candidate).toISOString();
    candidate += wallTime - Date.parse(`${displayed}:00Z`);
  }
  throw new Error("Такое местное время отсутствует в выбранном часовом поясе. Выберите соседнее время.");
}

export function calendarBoundary(key: string, timezone: string) {
  const center = Date.parse(`${key}T00:00:00Z`);
  let before = center - 2 * dayMs;
  let after = center + 2 * dayMs;
  // A time zone can skip midnight during a daylight-saving transition.
  while (after - before > 1) {
    const midpoint = Math.floor((before + after) / 2);
    if (dateKey(new Date(midpoint), timezone) < key) before = midpoint;
    else after = midpoint;
  }
  return new Date(after).toISOString();
}

function utcDate(key: string) {
  return new Date(`${key}T12:00:00.000Z`);
}

export function addDays(key: string, count: number) {
  return new Date(utcDate(key).getTime() + count * dayMs).toISOString().slice(0, 10);
}

export function addMonths(key: string, count: number) {
  const date = utcDate(key);
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + count);
  return date.toISOString().slice(0, 10);
}

export function startOfWeek(key: string) {
  return addDays(key, -((utcDate(key).getUTCDay() + 6) % 7));
}

export function monthStart(key: string) {
  return `${key.slice(0, 7)}-01`;
}

export function dateCaption(key: string, options: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat("ru", { ...options, timeZone: "UTC" }).format(utcDate(key));
}

export function formatDateTime(value: string | number | Date | null | undefined, timezone = "Europe/Minsk", format = "dd.MM.yyyy") {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  if (format === "d MMM yyyy") return new Intl.DateTimeFormat("ru", { dateStyle: "medium", timeStyle: "short", timeZone: timezone }).format(date);
  const { year, month, day, hour, minute } = localDateParts(date, timezone);
  return `${format === "yyyy-MM-dd" ? `${year}-${month}-${day}` : `${day}.${month}.${year}`} · ${hour}:${minute}`;
}

export function timeCaption(value: string, timezone: string) {
  return new Intl.DateTimeFormat("ru", { hour: "2-digit", minute: "2-digit", timeZone: timezone }).format(new Date(value));
}
