// Draws weekly npm downloads as SVG for the README, in a light and a dark variant.
//
// Run by .github/workflows/stats.yml: the output is pushed to the `stats` branch and the README
// embeds it from raw.githubusercontent.com. No dependencies, so the workflow needs no `npm ci`
// and pulls no third-party code into the job that can write to the repo.
//
// By hand: node scripts/download-chart.mjs <out-dir>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const PACKAGE = 'memhive';
const DAY = 86_400_000;
// The npm range API returns at most 18 months per call.
const MAX_RANGE_DAYS = 540;

// GitHub's palette, so the image blends into the README in both color modes.
export const THEMES = {
  light: {
    background: '#ffffff',
    border: '#d1d9e0',
    text: '#1f2328',
    muted: '#59636e',
    grid: '#eff2f5',
    bar: '#d4a017',
    release: '#5865f2',
  },
  dark: {
    background: '#0d1117',
    border: '#3d444d',
    text: '#f0f6fc',
    muted: '#9198a1',
    grid: '#21262d',
    bar: '#e3b341',
    release: '#8b9cff',
  },
};

const WIDTH = 800;
const HEIGHT = 320;
const PLOT = { left: 56, right: 24, top: 76, bottom: 40 };
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif";
const compact = new Intl.NumberFormat('en', { notation: 'compact' });
const full = new Intl.NumberFormat('en');
const monthName = new Intl.DateTimeFormat('en', { month: 'short', timeZone: 'UTC' });

/**
 * Groups daily downloads into weeks, counting back from the last day.
 * The last week always has 7 days; the first may be short.
 * @param {Array<{day: string, downloads: number}>} days Daily downloads, ascending
 * @returns {Array<{start: string, end: string, downloads: number}>}
 */
export function toWeeks(days) {
  const weeks = [];
  for (let end = days.length; end > 0; end -= 7) {
    const chunk = days.slice(Math.max(0, end - 7), end);
    weeks.unshift({
      start: chunk[0].day,
      end: chunk.at(-1).day,
      downloads: chunk.reduce((sum, day) => sum + day.downloads, 0),
    });
  }
  return weeks;
}

/**
 * A round y-axis step (1, 2, 5 x 10^n) so that `divisions` steps cover `max`.
 * @param {number} max Largest value to draw
 * @param {number} [divisions=4] Number of intervals on the axis
 * @returns {number}
 */
export function niceStep(max, divisions = 4) {
  const raw = Math.max(max / divisions, 1);
  const power = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].find((step) => step * power >= raw) * power;
}

/**
 * @param {string} text Text
 * @returns {string}
 */
function escapeXml(text) {
  return String(text).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/**
 * @param {string} day Date as YYYY-MM-DD
 * @returns {number}
 */
function time(day) {
  return Date.parse(`${day}T00:00:00Z`);
}

/**
 * Renders the chart as SVG.
 * @param {Object} stats Data
 * @param {Array<{start: string, end: string, downloads: number}>} stats.weeks Weekly downloads
 * @param {Array<{version: string, date: string}>} stats.releases Published versions
 * @param {string} stats.updated Date of the newest data point
 * @param {Object} theme One of THEMES
 * @returns {string}
 */
export function renderChart({ weeks: allWeeks, releases, updated }, theme) {
  const total = allWeeks.reduce((sum, week) => sum + week.downloads, 0);
  // The first week is usually short (published mid-week) and its low bar reads as a drop.
  // Leave it out of the bars, but keep it in the total.
  const weeks =
    allWeeks.length > 1 && time(allWeeks[0].end) - time(allWeeks[0].start) < 6 * DAY ? allWeeks.slice(1) : allWeeks;
  const plotWidth = WIDTH - PLOT.left - PLOT.right;
  const plotHeight = HEIGHT - PLOT.top - PLOT.bottom;
  const bottom = PLOT.top + plotHeight;
  const parts = [];

  parts.push(
    `<rect x="0.5" y="0.5" width="${WIDTH - 1}" height="${HEIGHT - 1}" rx="6" fill="${theme.background}" stroke="${theme.border}"/>`,
    `<text x="${PLOT.left - 32}" y="32" font-size="16" font-weight="600" fill="${theme.text}">npm downloads per week</text>`,
    `<text x="${PLOT.left - 32}" y="54" font-size="12" fill="${theme.muted}">${escapeXml(
      `${full.format(total)} total · ${PACKAGE} · updated ${updated}`
    )}</text>`
  );

  if (!weeks.length) {
    parts.push(
      `<text x="${WIDTH / 2}" y="${PLOT.top + plotHeight / 2}" font-size="13" text-anchor="middle" fill="${
        theme.muted
      }">No downloads recorded yet</text>`
    );
    return wrap(parts);
  }

  // Y axis and horizontal grid.
  const max = Math.max(...weeks.map((week) => week.downloads), 1);
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const y = (value) => bottom - (value / top) * plotHeight;
  for (let value = 0; value <= top; value += step) {
    parts.push(
      `<line x1="${PLOT.left}" x2="${WIDTH - PLOT.right}" y1="${y(value)}" y2="${y(value)}" stroke="${theme.grid}"/>`,
      `<text x="${PLOT.left - 8}" y="${y(value) + 4}" font-size="11" text-anchor="end" fill="${
        theme.muted
      }">${compact.format(value)}</text>`
    );
  }

  // Time-based x axis, so release lines land on their date rather than on a bar.
  const t0 = time(weeks[0].start);
  const t1 = time(weeks.at(-1).end) + DAY;
  const x = (t) => PLOT.left + ((t - t0) / (t1 - t0)) * plotWidth;

  for (const week of weeks) {
    const left = x(time(week.start));
    const width = x(time(week.end) + DAY) - left;
    const gap = Math.min(2, width * 0.15);
    parts.push(
      `<rect x="${(left + gap).toFixed(1)}" y="${y(week.downloads).toFixed(1)}" width="${Math.max(
        width - gap * 2,
        1
      ).toFixed(1)}" height="${(bottom - y(week.downloads)).toFixed(1)}" rx="2" fill="${theme.bar}">` +
        `<title>${escapeXml(`${week.start} – ${week.end}: ${full.format(week.downloads)}`)}</title></rect>`
    );
  }

  // Month labels, skipping ones that would crowd.
  let lastLabel = -Infinity;
  const first = new Date(t0);
  for (
    let month = Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 1);
    month < t1;
    month = Date.UTC(new Date(month).getUTCFullYear(), new Date(month).getUTCMonth() + 1, 1)
  ) {
    const at = x(month);
    if (at - lastLabel < 48) continue;
    lastLabel = at;
    const date = new Date(month);
    const label =
      date.getUTCMonth() === 0 ? `${monthName.format(date)} ${date.getUTCFullYear()}` : monthName.format(date);
    parts.push(
      `<line x1="${at}" x2="${at}" y1="${bottom}" y2="${bottom + 4}" stroke="${theme.muted}"/>`,
      `<text x="${at}" y="${bottom + 18}" font-size="11" text-anchor="middle" fill="${theme.muted}">${label}</text>`
    );
  }
  parts.push(
    `<line x1="${PLOT.left}" x2="${WIDTH - PLOT.right}" y1="${bottom}" y2="${bottom}" stroke="${theme.border}"/>`
  );

  // Release lines. Labels use two rows so releases a few days apart do not overlap.
  const rows = [-Infinity, -Infinity];
  for (const release of releases) {
    const date = time(release.date);
    if (date < time(allWeeks[0].start) || date >= t1) continue;
    // A release in the dropped first week is pinned to the left edge.
    const at = Math.max(x(date), PLOT.left);
    parts.push(
      `<line x1="${at}" x2="${at}" y1="${PLOT.top - 6}" y2="${bottom}" stroke="${theme.release}" stroke-dasharray="3 3"/>`
    );
    const row = rows.findIndex((last) => at - last > 56);
    if (row === -1) continue;
    rows[row] = at;
    // Near the right edge, put the label left of the line so it is not clipped.
    const left = at > WIDTH - PLOT.right - 48;
    parts.push(
      `<text x="${left ? at - 4 : at + 4}" y="${PLOT.top - 6 + row * 13}" font-size="11" font-weight="600" ` +
        `text-anchor="${left ? 'end' : 'start'}" fill="${theme.release}">${escapeXml(`v${release.version}`)}</text>`
    );
  }

  return wrap(parts);
}

/**
 * @param {string[]} parts SVG elements
 * @returns {string}
 */
function wrap(parts) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" ` +
    `font-family="${FONT}" role="img" aria-label="npm downloads per week">\n${parts.join('\n')}\n</svg>\n`
  );
}

/**
 * @param {string} url URL
 * @returns {Promise<Object>}
 */
async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
  return response.json();
}

/**
 * Fetches downloads and per-version publish dates from npm.
 * @param {string} [pkg=PACKAGE] Package name
 * @param {Date} [now=new Date()] Current time
 * @returns {Promise<Object>} Data for renderChart
 */
export async function fetchStats(pkg = PACKAGE, now = new Date()) {
  const registry = await getJson(`https://registry.npmjs.org/${pkg.replace('/', '%2F')}`);
  // Today is not over yet, so its numbers are incomplete.
  const end = new Date(now.getTime() - DAY).toISOString().slice(0, 10);
  const earliest = new Date(time(end) - MAX_RANGE_DAYS * DAY).toISOString().slice(0, 10);
  const created = registry.time.created.slice(0, 10);
  const start = created > earliest ? created : earliest;

  // A package created today has no full day of data yet, and the API rejects a start after the end.
  const { downloads } =
    start > end ? { downloads: [] } : await getJson(`https://api.npmjs.org/downloads/range/${start}:${end}/${pkg}`);
  const releases = Object.keys(registry.versions)
    // Skip the placeholder npm creates for a staged publish (0.0.0-stage).
    .filter((version) => registry.time[version] && !registry.versions[version].stub)
    .map((version) => ({ version, date: registry.time[version].slice(0, 10) }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return { weeks: toWeeks(downloads), releases, updated: downloads.at(-1)?.day ?? end };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = process.argv[2] ?? 'stats';
  mkdirSync(out, { recursive: true });
  const stats = await fetchStats();
  for (const [name, theme] of Object.entries(THEMES)) {
    writeFileSync(join(out, `downloads-${name}.svg`), renderChart(stats, theme));
  }
  const total = stats.weeks.reduce((sum, week) => sum + week.downloads, 0);
  console.log(`${PACKAGE}: ${stats.weeks.length} weeks, ${total} downloads, written to ${out}/`);
}
