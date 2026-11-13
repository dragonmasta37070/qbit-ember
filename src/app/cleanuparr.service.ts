import { Injectable, signal } from '@angular/core';

// Optional integration. Cleanuparr is proxied by nginx at /cleanuparr/, which
// also injects the API key. Everything here degrades to "not there": if the
// proxy is absent (dev server), the host unreachable or the key wrong, the UI
// simply never shows Cleanuparr.
//
// Endpoints (Cleanuparr current API):
//   GET /api/v2/stats?hours=N   aggregated stats. v1 /api/stats was REMOVED.
//   GET /api/events?pageSize=N  event log, carries itemHash and strikeCount.

export interface CleanuparrJob { name: string; totalRuns: number; failed: number; }

/** Latest Cleanuparr event that names a specific torrent, keyed by hash. */
export interface CleanuparrItem {
  hash: string;
  strikes: number | null;
  eventType: string;
  message: string;
  reason: string;
  at: string;
  severity: string;
}

export interface CleanuparrStats {
  events: number;
  strikes: number;
  /** Downloads Cleanuparr removed from the queue (v2: `removals.total`). */
  itemsRemoved: number;
  jobs: CleanuparrJob[];
  failedJobs: number;
}

export type CleanuparrStatus =
  | 'unknown'       // no answer yet
  | 'ok'            // 200
  | 'unauthorized'  // 401/403 — Cleanuparr is there, the key is not accepted
  | 'unsupported'   // 404 — this build has no /api/v2/stats
  | 'unreachable';  // 502 from nginx, or the request failed outright

export interface CleanuparrDescription { text: string; sub: string; tone: 'ok' | 'warn' | 'bad' | 'idle'; }

const STATS_PATH = '/cleanuparr/api/v2/stats';
const EVENTS_PATH = '/cleanuparr/api/events';
const POLL_MS = 60_000;   // ponytail: cleanup stats move slowly, no need for the 1.1s torrent cadence
const IDLE_MS = 600_000;  // never configured: back off hard so an absent Cleanuparr costs nothing
const WINDOW_H = 24;
const EVENT_PAGE = 200;   // server clamps at 500
const SEEN_KEY = 'cleanuparr-seen';
// How long a past sighting keeps counting as "configured". Long enough that an
// outage over a weekend is still reported, short enough that removing
// Cleanuparr for good stops nagging on its own.
const SEEN_TTL_MS = 7 * 24 * 3600_000;

@Injectable({ providedIn: 'root' })
export class CleanuparrService {
  readonly status = signal<CleanuparrStatus>('unknown');
  /** HTTP code behind the status, so the UI can name it. Null on a network error. */
  readonly httpStatus = signal<number | null>(null);
  readonly stats = signal<CleanuparrStats | null>(null);
  /** hash (lowercase) → most recent event naming that torrent */
  readonly items = signal<Map<string, CleanuparrItem>>(new Map());
  readonly reachable = signal(false);
  /** True once Cleanuparr has answered at all — persisted, so a restart while
   *  it is down still counts as "configured but silent" rather than "never set
   *  up". An answer of 401 or 404 counts: something is there to answer. */
  readonly configured = signal(seenRecently());

  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor() { this.start(); }

  start(): void {
    if (this.timer) return;
    void this.poll();
  }

  private async poll(): Promise<void> {
    try {
      const r = await fetch(`${STATS_PATH}?hours=${WINDOW_H}`);
      this.httpStatus.set(r.status);
      if (r.ok) {
        this.stats.set(parseStatsV2(await r.json()));
        this.reachable.set(true);
        this.status.set('ok');
        void this.fetchEvents();
        this.markSeen();
      } else if (r.status === 401 || r.status === 403) {
        this.reachable.set(false);
        this.status.set('unauthorized');
        this.markSeen();
      } else if (r.status === 404) {
        // Reached Cleanuparr, but this build predates /api/v2/stats.
        this.reachable.set(false);
        this.status.set('unsupported');
        this.markSeen();
      } else {
        this.reachable.set(false);
        this.status.set('unreachable');
      }
    } catch {
      this.httpStatus.set(null);
      this.reachable.set(false);
      this.status.set('unreachable');
    }
    // Back off when Cleanuparr was never there — otherwise every minute burns
    // a proxy timeout and a line of nginx error log for nothing.
    const next = this.configured() ? POLL_MS : IDLE_MS;
    this.timer = setTimeout(() => void this.poll(), next);
  }

  private markSeen(): void {
    this.configured.set(true);
    localStorage.setItem(SEEN_KEY, String(Date.now()));
  }

  /** Events carry the torrent hash, which is what makes the per-torrent
   *  context possible. Failure here only costs that context, never the rest. */
  private async fetchEvents(): Promise<void> {
    try {
      const r = await fetch(`${EVENTS_PATH}?pageSize=${EVENT_PAGE}`);
      if (!r.ok) return;
      this.items.set(indexEvents(await r.json()));
    } catch {
      // leave the previous map in place
    }
  }
}

/** Newest event per torrent hash. Exported for the test. */
export function indexEvents(body: any): Map<string, CleanuparrItem> {
  const list: any[] = Array.isArray(body) ? body : body?.items ?? [];
  const map = new Map<string, CleanuparrItem>();
  for (const e of list) {
    const hash = String(e?.itemHash ?? '').toLowerCase();
    if (!hash) continue;
    // the API returns newest first, so the first hit per hash wins
    if (map.has(hash)) continue;
    map.set(hash, {
      hash,
      strikes: typeof e?.strikeCount === 'number' ? e.strikeCount : null,
      eventType: humanize(e?.eventType ?? ''),
      message: e?.message ?? '',
      reason: reasonOf(e),
      at: e?.timestamp ?? '',
      severity: e?.severity ?? 'Information',
    });
  }
  return map;
}

/**
 * Maps the /api/v2/stats payload. The v1 shape it replaced used
 * `events.totalCount`, `strikes.totalCount`, `strikes.itemsRemoved` and
 * `jobs.byType.*.totalRuns`; none of those exist any more.
 */
export function parseStatsV2(d: any): CleanuparrStats {
  const byType = d?.jobs?.byType ?? {};
  const jobs: CleanuparrJob[] = Object.entries(byType).map(([name, j]: [string, any]) => ({
    name,
    totalRuns: j?.total ?? 0,
    failed: j?.failed ?? 0,
  }));
  return {
    events: d?.events?.total ?? 0,
    strikes: d?.strikes?.total ?? 0,
    itemsRemoved: d?.removals?.total ?? 0,
    jobs,
    // jobs.failed is the server's own total; fall back to summing the types.
    failedJobs: typeof d?.jobs?.failed === 'number'
      ? d.jobs.failed
      : jobs.reduce((n, j) => n + j.failed, 0),
  };
}

/**
 * Turns a poll result into something the user can act on. Every failure names
 * what went wrong and which variable to look at, instead of the old blanket
 * "set CLEANUPARR_URL" that also fired on a wrong key or an old version.
 */
export function describeCleanuparr(
  status: CleanuparrStatus,
  httpStatus: number | null,
  configured: boolean,
): CleanuparrDescription {
  const code = httpStatus ? ` (HTTP ${httpStatus})` : '';
  switch (status) {
    case 'ok':
      return { text: 'Connected', sub: 'Stats and strikes available', tone: 'ok' };
    case 'unauthorized':
      return { text: 'API key rejected', sub: `Check CLEANUPARR_API_KEY${code}`, tone: 'bad' };
    case 'unsupported':
      return {
        text: 'Unsupported Cleanuparr version',
        sub: `No /api/v2/stats${code} — update Cleanuparr`,
        tone: 'bad',
      };
    case 'unreachable':
      // Never having reached it is not a fault — the integration is optional,
      // and an unset CLEANUPARR_URL looks exactly like this from the browser.
      return configured
        ? { text: 'Not reachable', sub: `Check CLEANUPARR_URL and the container${code}`, tone: 'warn' }
        : { text: 'Not connected', sub: 'Optional — set CLEANUPARR_URL to enable', tone: 'idle' };
    default:
      return { text: 'Checking …', sub: '', tone: 'idle' };
  }
}

function humanize(type: string): string {
  const words = type.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return words.charAt(0) + words.slice(1).toLowerCase();
}

function reasonOf(e: any): string {
  const failed = Array.isArray(e?.failedImportReasons) ? e.failedImportReasons : [];
  return e?.deleteReason ?? e?.cleanReason ?? (failed.length ? failed.join(', ') : '');
}

function seenRecently(): boolean {
  const at = Number(localStorage.getItem(SEEN_KEY));
  if (!at) return false;
  if (Date.now() - at > SEEN_TTL_MS) {
    localStorage.removeItem(SEEN_KEY);
    return false;
  }
  return true;
}
