/**
 * DeepSeek API peak/off-peak pricing window (pure logic, no dependencies).
 *
 * Official rule (https://api-docs.deepseek.com/quick_start/pricing):
 *   Peak = UTC Mon-Fri 01:00-04:00 and 06:00-10:00, i.e. Beijing time
 *   (UTC+8) Mon-Fri 09:00-12:00 and 14:00-18:00, both half-open.
 *   Weekends and Chinese statutory holidays are off-peak all day.
 *
 * Mirrors the table already used by dsh-whale-girl-pet so the router and the
 * pet's cost report never disagree.
 */

/** Chinese statutory holidays (Beijing dates, YYYY-MM-DD), 2026 State Council schedule. */
export const CN_STATUTORY_HOLIDAYS = new Set([
  // 元旦
  '2026-01-01', '2026-01-02', '2026-01-03',
  // 春节
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  // 清明节
  '2026-04-04', '2026-04-05', '2026-04-06',
  // 劳动节
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  // 端午节
  '2026-06-19', '2026-06-20', '2026-06-21',
  // 中秋节
  '2026-09-25', '2026-09-26', '2026-09-27',
  // 国庆节
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
  '2026-10-05', '2026-10-06', '2026-10-07',
]);

/** Beijing date string (YYYY-MM-DD). China has no DST, so a fixed +8 offset is exact. */
export function beijingDate(timeMs) {
  return new Date(timeMs + 8 * 3600e3).toISOString().slice(0, 10);
}

/**
 * Whether Beijing time is inside DeepSeek's peak-priced window.
 * @param timeMs UTC epoch milliseconds.
 * @returns true only for weekday peak windows outside statutory holidays.
 */
export function isPeakBeijing(timeMs) {
  if (!Number.isFinite(timeMs)) return false;
  if (CN_STATUTORY_HOLIDAYS.has(beijingDate(timeMs))) return false;
  const bj = new Date(timeMs + 8 * 3600e3);
  const weekday = bj.getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  const minutes = bj.getUTCHours() * 60 + bj.getUTCMinutes();
  return (minutes >= 9 * 60 && minutes < 12 * 60) || (minutes >= 14 * 60 && minutes < 18 * 60);
}

/** Human-readable Beijing clock for logs. */
export function beijingClock(timeMs) {
  return new Date(timeMs + 8 * 3600e3).toISOString().slice(11, 16);
}

/** Next instant the peak window starts (Beijing), for log hints. */
export function nextPeakStart(timeMs) {
  const bj = new Date(timeMs + 8 * 3600e3);
  const day = bj.getUTCDay();
  if (day === 0 || day === 6) return undefined;
  const minutes = bj.getUTCHours() * 60 + bj.getUTCMinutes();
  if (minutes < 9 * 60) return timeMs + (9 * 60 - minutes) * 60e3;
  if (minutes >= 12 * 60 && minutes < 14 * 60) return timeMs + (14 * 60 - minutes) * 60e3;
  return undefined;
}
