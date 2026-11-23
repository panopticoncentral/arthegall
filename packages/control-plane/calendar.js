import { DateTime, IANAZone } from "luxon";

const days = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

export function timing(options, now) {
  const { at, in: delay, time, days: selected, zone = "UTC", missed } = options;
  if (!IANAZone.isValidZone(zone)) throw Error("expected an IANA time zone");
  if ([at, delay, time].filter((v) => v !== undefined).length !== 1)
    throw Error("choose exactly one of --at, --in or --time");
  if (time === undefined) {
    if (missed !== undefined || selected !== undefined)
      throw Error("--missed and --days require a recurring schedule");
    let first;
    if (at !== undefined) {
      if (!/T\d{2}:\d{2}.*(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)$/i.test(at))
        throw Error("--at requires an ISO timestamp with an explicit offset");
      first = DateTime.fromISO(at, { setZone: true });
    } else {
      const match = /^(\d+)(s|m|h|d)$/.exec(delay);
      if (!match || Number(match[1]) <= 0)
        throw Error("expected a delay such as 5m");
      const unit = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[match[2]];
      first = DateTime.fromMillis(now + Number(match[1]) * unit);
    }
    first = first.toUTC();
    if (!first.isValid || first.toMillis() <= now || first.year > 9999)
      throw Error("expected a valid future time");
    return { kind: "once", zone, at: first.toISO() };
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))
    throw Error("expected HH:MM in 24-hour time");
  const names =
    selected === undefined || selected === "daily"
      ? days
      : selected === "weekdays"
        ? days.slice(0, 5)
        : String(selected).toLowerCase().split(",");
  if (!names.every((d) => days.includes(d)))
    throw Error("expected weekdays, daily, or mon,tue,...");
  if (missed !== undefined && !["latest", "backfill"].includes(missed))
    throw Error("--missed must be latest or backfill");
  return {
    kind: "recurring",
    zone,
    time,
    days: days.filter((d) => names.includes(d)),
    missed: missed ?? "latest",
  };
}

// Work in calendar days. Reconstruct the requested wall time every day so
// a spring-forward adjustment cannot shift the next day's occurrence.
export function nextDue(rule, after) {
  if (rule.kind === "once") return Date.parse(rule.at) > after ? rule.at : null;
  const [hour, minute] = rule.time.split(":").map(Number);
  const local = DateTime.fromMillis(after, { zone: rule.zone });
  let date = DateTime.utc(local.year, local.month, local.day);
  for (;;) {
    if (rule.days.includes(days[date.weekday - 1])) {
      const candidate = DateTime.fromObject(
        {
          year: date.year,
          month: date.month,
          day: date.day,
          hour,
          minute,
        },
        { zone: rule.zone },
      );
      const first = Math.min(
        ...candidate.getPossibleOffsets().map((t) => t.toMillis()),
      );
      if (first > after) return new Date(first).toISOString();
    }
    date = date.plus({ days: 1 });
  }
}

export function localTime(instant, zone) {
  return DateTime.fromISO(instant, { zone }).toISO({
    suppressMilliseconds: true,
  });
}

export function preview(schedule) {
  const upcoming = [];
  let due = schedule.nextDue;
  while (due && upcoming.length < 3) {
    upcoming.push(localTime(due, schedule.rule.zone));
    due = nextDue(schedule.rule, Date.parse(due));
  }
  return { ...schedule, upcoming };
}
