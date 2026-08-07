import {
  intrinsicUint8ArrayByteLength,
  snapshotUint8Array,
} from "../protocol/bytes.js";

/** Validate a node-rfc-compatible DATS input without inventing a calendar value. */
export function assertClassicDate(value: string, path: string): void {
  if (typeof value !== "string" || !/^(?:\d{8}| {8}|)$/u.test(value)) {
    throw new TypeError(`${path} expects YYYYMMDD, an empty string, or eight spaces`);
  }
}

/** Validate a node-rfc-compatible TIMS input without inventing a clock value. */
export function assertClassicTime(value: string, path: string): void {
  if (typeof value !== "string" || !/^(?:\d{6}| {6}|)$/u.test(value)) {
    throw new TypeError(`${path} expects HHMMSS, an empty string, or six spaces`);
  }
}

/** Convert a public DATE value into the exact eight-character wire form. */
export function classicDateWireText(value: string, path: string): string {
  assertClassicDate(value, path);
  return value === "" ? "        " : value;
}

/** Convert an exact DATE wire value to node-rfc's trailing-space-trimmed form. */
export function classicDatePublicText(value: string, path: string): string {
  if (!/^(?:\d{8}| {8})$/u.test(value)) {
    throw new TypeError(`${path} expects YYYYMMDD or eight spaces from the wire`);
  }
  return value === "        " ? "" : value;
}

/** Convert a public TIME value into the exact six-character wire form. */
export function classicTimeWireText(value: string, path: string): string {
  assertClassicTime(value, path);
  return value === "" ? "      " : value;
}

/** Convert an exact TIME wire value to node-rfc's trailing-space-trimmed form. */
export function classicTimePublicText(value: string, path: string): string {
  if (!/^(?:\d{6}| {6})$/u.test(value)) {
    throw new TypeError(`${path} expects HHMMSS or six spaces from the wire`);
  }
  return value === "      " ? "" : value;
}

/** Classic RFC EXIDs backed by SAP's compact integer temporal values. */
export type ClassicTemporalExid =
  | "p" // UTCLONG
  | "n" // UTCSECOND
  | "w" // UTCMINUTE
  | "d" // DTDAY
  | "7" // DTWEEK
  | "x" // DTMONTH
  | "t" // TSECOND
  | "i" // TMINUTE
  | "c"; // CDAY

interface TemporalSpecification {
  readonly name: string;
  readonly byteLength: 2 | 4 | 8;
  readonly maximumRaw: bigint;
}

const SPECIFICATIONS: Readonly<Record<ClassicTemporalExid, TemporalSpecification>> =
  Object.freeze({
    p: Object.freeze({
      name: "UTCLONG",
      byteLength: 8,
      maximumRaw: 3_155_380_704_000_000_000n,
    }),
    n: Object.freeze({
      name: "UTCSECOND",
      byteLength: 8,
      maximumRaw: 315_538_070_400n,
    }),
    w: Object.freeze({
      name: "UTCMINUTE",
      byteLength: 8,
      maximumRaw: 5_258_967_840n,
    }),
    d: Object.freeze({
      name: "DTDAY",
      byteLength: 4,
      maximumRaw: 3_652_061n,
    }),
    "7": Object.freeze({
      name: "DTWEEK",
      byteLength: 4,
      maximumRaw: 521_725n,
    }),
    x: Object.freeze({
      name: "DTMONTH",
      byteLength: 4,
      maximumRaw: 119_988n,
    }),
    t: Object.freeze({
      name: "TSECOND",
      byteLength: 4,
      maximumRaw: 86_401n,
    }),
    i: Object.freeze({
      name: "TMINUTE",
      byteLength: 2,
      maximumRaw: 1_441n,
    }),
    c: Object.freeze({
      name: "CDAY",
      byteLength: 2,
      maximumRaw: 366n,
    }),
  });

const DAYS_BY_MONTH = Object.freeze([
  31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
] as const);

const UTCLONG_INITIAL = "0000-00-00T00:00:00.0000000";
const SECONDS_PER_DAY = 86_400;
const MINUTES_PER_DAY = 1_440;
const FRACTIONS_PER_SECOND = 10_000_000n;
const FRACTIONS_PER_DAY = 864_000_000_000n;

interface CalendarDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

interface ClockTime {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

/** Return whether a metadata EXID selects one of the compact temporal codecs. */
export function isClassicTemporalExid(value: string): value is ClassicTemporalExid {
  switch (value) {
    case "p":
    case "n":
    case "w":
    case "d":
    case "7":
    case "x":
    case "t":
    case "i":
    case "c":
      return true;
    default:
      return false;
  }
}

function specification(exid: ClassicTemporalExid): TemporalSpecification {
  if (!isClassicTemporalExid(exid)) {
    throw new TypeError("unsupported classic temporal EXID");
  }
  return SPECIFICATIONS[exid];
}

/** Return the fixed SAP raw width for a compact temporal EXID. */
export function classicTemporalByteLength(exid: ClassicTemporalExid): number {
  return specification(exid).byteLength;
}

/** Return the compatibility-facing initial string for a compact temporal EXID. */
export function classicTemporalInitialValue(exid: ClassicTemporalExid): string {
  specification(exid);
  return exid === "p" ? UTCLONG_INITIAL : "";
}

function expectString(
  value: unknown,
  expected: string,
  path: string,
  name: string,
): asserts value is string {
  if (typeof value !== "string") {
    throw new TypeError(`${path} ${name} expects a string in ${expected} form`);
  }
}

function expectForm(
  value: string,
  expression: RegExp,
  expected: string,
  path: string,
  name: string,
): RegExpExecArray {
  const match = expression.exec(value);
  if (match === null) {
    throw new TypeError(`${path} ${name} expects ${expected}`);
  }
  return match;
}

function isLeapYear(year: number): boolean {
  if (year < 1582) return year % 4 === 0;
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  if (year === 1582 && month === 10) return 21;
  return DAYS_BY_MONTH[month - 1]!;
}

function parseDateParts(
  match: RegExpExecArray,
  path: string,
  name: string,
): CalendarDate {
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || year > 9999) {
    throw new RangeError(`${path} ${name} year must be in 0001..9999`);
  }
  if (month < 1 || month > 12) {
    throw new RangeError(`${path} ${name} month must be in 01..12`);
  }
  const conventionalMaximum = month === 2
    ? (isLeapYear(year) ? 29 : 28)
    : DAYS_BY_MONTH[month - 1]!;
  if (day < 1 || day > conventionalMaximum) {
    throw new RangeError(
      `${path} ${name} has invalid day ${String(day).padStart(2, "0")}`,
    );
  }
  if (year === 1582 && month === 10 && day >= 5 && day <= 14) {
    throw new RangeError(
      `${path} ${name} is in the Gregorian calendar gap 1582-10-05..1582-10-14`,
    );
  }
  return { year, month, day };
}

function daysInPreviousYears(year: number): number {
  const previousYears = year - 1;
  const through1600 = Math.min(previousYears, 1600);
  const withinCentury = through1600 % 100;
  let days = Math.floor(through1600 / 100) * 36_525
    + Math.floor(withinCentury / 4) * 1_461
    + (withinCentury % 4) * 365;

  if (year > 1582) days -= 10;
  if (previousYears <= 1600) return days;

  let after1600 = previousYears - 1600;
  days += Math.floor(after1600 / 400) * 146_097;
  after1600 %= 400;
  const finalCentury = after1600 % 100;
  return days
    + Math.floor(after1600 / 100) * 36_524
    + Math.floor(finalCentury / 4) * 1_461
    + (finalCentury % 4) * 365;
}

function dateOrdinal(date: CalendarDate): number {
  let result = daysInPreviousYears(date.year);
  for (let month = 1; month < date.month; month += 1) {
    result += daysInMonth(date.year, month);
  }
  const adjustedDay = date.year === 1582 && date.month === 10 && date.day >= 15
    ? date.day - 10
    : date.day;
  return result + adjustedDay - 1;
}

function dateFromOrdinal(ordinal: number): CalendarDate {
  let lower = 1;
  let upper = 9999;
  while (lower <= upper) {
    const candidate = Math.floor((lower + upper) / 2);
    if (daysInPreviousYears(candidate) <= ordinal) {
      lower = candidate + 1;
    } else {
      upper = candidate - 1;
    }
  }

  const year = upper;
  let remaining = ordinal - daysInPreviousYears(year);
  let month = 1;
  while (month <= 12) {
    const monthLength = daysInMonth(year, month);
    if (remaining < monthLength) break;
    remaining -= monthLength;
    month += 1;
  }
  let day = remaining + 1;
  if (year === 1582 && month === 10 && day > 4) day += 10;
  return { year, month, day };
}

function twoDigits(value: number): string {
  return value.toString().padStart(2, "0");
}

function fourDigits(value: number): string {
  return value.toString().padStart(4, "0");
}

function formatDate(date: CalendarDate): string {
  return `${fourDigits(date.year)}-${twoDigits(date.month)}-${twoDigits(date.day)}`;
}

function parseClock(
  hour: number,
  minute: number,
  second: number,
  allowEndOfDay: boolean,
  path: string,
  name: string,
): ClockTime {
  const maximumHour = allowEndOfDay ? 24 : 23;
  if (hour < 0 || hour > maximumHour) {
    throw new RangeError(
      `${path} ${name} hours must be in 00..${String(maximumHour)}`,
    );
  }
  if (minute < 0 || minute > 59) {
    throw new RangeError(`${path} ${name} minutes must be in 00..59`);
  }
  if (second < 0 || second > 59) {
    throw new RangeError(`${path} ${name} seconds must be in 00..59`);
  }
  if (hour === 24 && (minute !== 0 || second !== 0)) {
    const maximum = name === "TMINUTE" ? "24:00" : "24:00:00";
    throw new RangeError(`${path} ${name} must not exceed ${maximum}`);
  }
  return { hour, minute, second };
}

function clockSeconds(clock: ClockTime): number {
  return clock.hour * 3_600 + clock.minute * 60 + clock.second;
}

function formatClock(seconds: number, includeSeconds: boolean): string {
  const hour = Math.floor(seconds / 3_600);
  const afterHours = seconds % 3_600;
  const minute = Math.floor(afterHours / 60);
  if (!includeSeconds) return `${twoDigits(hour)}:${twoDigits(minute)}`;
  return `${twoDigits(hour)}:${twoDigits(minute)}:${twoDigits(afterHours % 60)}`;
}

function calendarYearHasWeek53(year: number): boolean {
  const januaryFirst = (5 + daysInPreviousYears(year)) % 7;
  return januaryFirst === 3 || (januaryFirst === 2 && isLeapYear(year));
}

const YEARS_WITH_WEEK_53: readonly number[] = Object.freeze((() => {
  const result: number[] = [];
  for (let year = 1; year <= 9999; year += 1) {
    if (calendarYearHasWeek53(year)) result.push(year);
  }
  return result;
})());

function priorWeek53Count(year: number): number {
  let lower = 0;
  let upper = YEARS_WITH_WEEK_53.length;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (YEARS_WITH_WEEK_53[middle]! < year) lower = middle + 1;
    else upper = middle;
  }
  return lower;
}

function weekOrdinal(year: number, week: number, path: string): number {
  if (year === 0) {
    if (week === 53) return 0;
    throw new RangeError(`${path} DTWEEK year zero permits only 0000-W53`);
  }
  const priorLongYears = priorWeek53Count(year);
  if (week === 53 && YEARS_WITH_WEEK_53[priorLongYears] !== year) {
    throw new RangeError(`${path} DTWEEK year ${fourDigits(year)} does not have week 53`);
  }
  return priorLongYears * 53 + (year - 1 - priorLongYears) * 52 + week;
}

function weekFromOrdinal(ordinal: number): readonly [year: number, week: number] {
  if (ordinal === 0) return [0, 53];
  let lower = 1;
  let upper = 9999;
  while (lower < upper) {
    const year = Math.floor((lower + upper) / 2);
    const throughYear = year * 52 + priorWeek53Count(year + 1);
    if (ordinal <= throughYear) upper = year;
    else lower = year + 1;
  }
  const year = lower;
  const beforeYear = (year - 1) * 52 + priorWeek53Count(year);
  return [year, ordinal - beforeYear];
}

function encodeRaw(
  exid: ClassicTemporalExid,
  raw: bigint,
  path: string,
): Buffer {
  const spec = specification(exid);
  if (raw < 0n || raw > spec.maximumRaw) {
    throw new RangeError(`${path} ${spec.name} is outside its valid raw range`);
  }
  const result = Buffer.alloc(spec.byteLength);
  if (spec.byteLength === 8) result.writeBigInt64LE(raw);
  else if (spec.byteLength === 4) result.writeInt32LE(Number(raw));
  else result.writeInt16LE(Number(raw));
  return result;
}

function rawValue(
  exid: ClassicTemporalExid,
  value: Uint8Array,
  path: string,
): bigint {
  const spec = specification(exid);
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`${path} ${spec.name} expects Uint8Array raw bytes`);
  }
  const byteLength = intrinsicUint8ArrayByteLength(value);
  if (byteLength !== spec.byteLength) {
    throw new RangeError(
      `${path} ${spec.name} expects ${spec.byteLength} raw bytes; received ${byteLength}`,
    );
  }
  const bytes = snapshotUint8Array(value, `${path} ${spec.name}`, byteLength);
  const raw = spec.byteLength === 8
    ? bytes.readBigInt64LE(0)
    : spec.byteLength === 4
      ? BigInt(bytes.readInt32LE(0))
      : BigInt(bytes.readInt16LE(0));
  if (raw < 0n || raw > spec.maximumRaw) {
    throw new RangeError(`${path} ${spec.name} is outside its valid raw range`);
  }
  return raw;
}

/** Encode a compact SAP temporal string to its signed little-endian RFC value. */
export function encodeClassicTemporal(
  exid: ClassicTemporalExid,
  value: string,
  path = "classic temporal value",
): Buffer {
  const spec = specification(exid);
  expectString(value, "the documented fixed", path, spec.name);
  if (value.length === 0 || (exid === "p" && value === UTCLONG_INITIAL)) {
    return encodeRaw(exid, 0n, path);
  }

  let raw: bigint;
  switch (exid) {
    case "p": {
      const match = expectForm(
        value,
        /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{7})$/u,
        "YYYY-MM-DDTHH:MM:SS.fffffff",
        path,
        spec.name,
      );
      const date = parseDateParts(match, path, spec.name);
      const clock = parseClock(
        Number(match[4]), Number(match[5]), Number(match[6]), false, path, spec.name,
      );
      raw = (BigInt(dateOrdinal(date) * SECONDS_PER_DAY + clockSeconds(clock))
        * FRACTIONS_PER_SECOND) + BigInt(match[7]!) + 1n;
      break;
    }
    case "n": {
      const match = expectForm(
        value,
        /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/u,
        "YYYY-MM-DDTHH:MM:SS",
        path,
        spec.name,
      );
      const date = parseDateParts(match, path, spec.name);
      const clock = parseClock(
        Number(match[4]), Number(match[5]), Number(match[6]), false, path, spec.name,
      );
      raw = BigInt(dateOrdinal(date) * SECONDS_PER_DAY + clockSeconds(clock)) + 1n;
      break;
    }
    case "w": {
      const match = expectForm(
        value,
        /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u,
        "YYYY-MM-DDTHH:MM",
        path,
        spec.name,
      );
      const date = parseDateParts(match, path, spec.name);
      const clock = parseClock(
        Number(match[4]), Number(match[5]), 0, false, path, spec.name,
      );
      raw = BigInt(dateOrdinal(date) * MINUTES_PER_DAY + clock.hour * 60 + clock.minute) + 1n;
      break;
    }
    case "d": {
      const match = expectForm(
        value,
        /^(\d{4})-(\d{2})-(\d{2})$/u,
        "YYYY-MM-DD",
        path,
        spec.name,
      );
      raw = BigInt(dateOrdinal(parseDateParts(match, path, spec.name))) + 1n;
      break;
    }
    case "7": {
      const match = expectForm(
        value,
        /^(\d{4})-W(\d{2})$/u,
        "YYYY-Www",
        path,
        spec.name,
      );
      const year = Number(match[1]);
      const week = Number(match[2]);
      if (week < 1 || week > 53) {
        throw new RangeError(`${path} ${spec.name} week must be in 01..53`);
      }
      raw = BigInt(weekOrdinal(year, week, path)) + 1n;
      break;
    }
    case "x": {
      const match = expectForm(
        value,
        /^(\d{4})-(\d{2})$/u,
        "YYYY-MM",
        path,
        spec.name,
      );
      const year = Number(match[1]);
      const month = Number(match[2]);
      if (year < 1 || year > 9999) {
        throw new RangeError(`${path} ${spec.name} year must be in 0001..9999`);
      }
      if (month < 1 || month > 12) {
        throw new RangeError(`${path} ${spec.name} month must be in 01..12`);
      }
      raw = BigInt((year - 1) * 12 + month);
      break;
    }
    case "t": {
      const match = expectForm(
        value,
        /^(\d{2}):(\d{2}):(\d{2})$/u,
        "HH:MM:SS",
        path,
        spec.name,
      );
      const clock = parseClock(
        Number(match[1]), Number(match[2]), Number(match[3]), true, path, spec.name,
      );
      raw = BigInt(clockSeconds(clock)) + 1n;
      break;
    }
    case "i": {
      const match = expectForm(
        value,
        /^(\d{2}):(\d{2})$/u,
        "HH:MM",
        path,
        spec.name,
      );
      const clock = parseClock(
        Number(match[1]), Number(match[2]), 0, true, path, spec.name,
      );
      raw = BigInt(clock.hour * 60 + clock.minute) + 1n;
      break;
    }
    case "c": {
      const match = expectForm(
        value,
        /^(\d{2})-(\d{2})$/u,
        "MM-DD",
        path,
        spec.name,
      );
      const month = Number(match[1]);
      const day = Number(match[2]);
      if (month < 1 || month > 12) {
        throw new RangeError(`${path} ${spec.name} month must be in 01..12`);
      }
      if (day < 1 || day > DAYS_BY_MONTH[month - 1]!) {
        throw new RangeError(`${path} ${spec.name} has invalid day ${twoDigits(day)}`);
      }
      let ordinal = day;
      for (let candidate = 1; candidate < month; candidate += 1) {
        ordinal += DAYS_BY_MONTH[candidate - 1]!;
      }
      raw = BigInt(ordinal);
      break;
    }
  }
  return encodeRaw(exid, raw, path);
}

/** Decode one fixed-width compact SAP temporal value to its compatibility string. */
export function decodeClassicTemporal(
  exid: ClassicTemporalExid,
  value: Uint8Array,
  path = "classic temporal value",
): string {
  const raw = rawValue(exid, value, path);
  if (raw === 0n) return classicTemporalInitialValue(exid);
  const ordinal = raw - 1n;

  switch (exid) {
    case "p": {
      const dayOrdinal = Number(ordinal / FRACTIONS_PER_DAY);
      const withinDay = ordinal % FRACTIONS_PER_DAY;
      const seconds = Number(withinDay / FRACTIONS_PER_SECOND);
      const fraction = withinDay % FRACTIONS_PER_SECOND;
      return `${formatDate(dateFromOrdinal(dayOrdinal))}T${formatClock(seconds, true)}.`
        + fraction.toString().padStart(7, "0");
    }
    case "n": {
      const dayOrdinal = Number(ordinal / BigInt(SECONDS_PER_DAY));
      const seconds = Number(ordinal % BigInt(SECONDS_PER_DAY));
      return `${formatDate(dateFromOrdinal(dayOrdinal))}T${formatClock(seconds, true)}`;
    }
    case "w": {
      const dayOrdinal = Number(ordinal / BigInt(MINUTES_PER_DAY));
      const minutes = Number(ordinal % BigInt(MINUTES_PER_DAY));
      return `${formatDate(dateFromOrdinal(dayOrdinal))}T`
        + `${twoDigits(Math.floor(minutes / 60))}:${twoDigits(minutes % 60)}`;
    }
    case "d":
      return formatDate(dateFromOrdinal(Number(ordinal)));
    case "7": {
      const [year, week] = weekFromOrdinal(Number(ordinal));
      return `${fourDigits(year)}-W${twoDigits(week)}`;
    }
    case "x": {
      const monthOrdinal = Number(ordinal);
      return `${fourDigits(Math.floor(monthOrdinal / 12) + 1)}-`
        + twoDigits((monthOrdinal % 12) + 1);
    }
    case "t":
      return formatClock(Number(ordinal), true);
    case "i": {
      const minutes = Number(ordinal);
      return `${twoDigits(Math.floor(minutes / 60))}:${twoDigits(minutes % 60)}`;
    }
    case "c": {
      let remaining = Number(ordinal);
      let month = 1;
      while (remaining >= DAYS_BY_MONTH[month - 1]!) {
        remaining -= DAYS_BY_MONTH[month - 1]!;
        month += 1;
      }
      return `${twoDigits(month)}-${twoDigits(remaining + 1)}`;
    }
  }
}
