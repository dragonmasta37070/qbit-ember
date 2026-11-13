import { describeCleanuparr, indexEvents, parseStatsV2 } from './cleanuparr.service';

// Trimmed from the documented /api/v2/stats response
// (Cleanuparr docs → Configuration → Stats API).
const V2_RESPONSE = {
  events: { total: 60, byType: { StalledStrike: 12 }, bySeverity: { Warning: 20 } },
  strikes: { total: 24, byType: { Stalled: 12 }, recovered: 3 },
  removals: { total: 13, byReason: { Stalled: 2 } },
  cleaned: { total: 6, byReason: { MaxRatioReached: 4 } },
  searches: { total: 8, completed: 6, failed: 1, grabbed: 5, byReason: {} },
  jobs: {
    total: 168,
    completed: 165,
    failed: 3,
    byType: {
      QueueCleaner: { total: 48, completed: 46, failed: 2, lastRunAt: '2025-01-15T12:00:00Z', nextRunAt: null },
      MalwareBlocker: { total: 48, completed: 47, failed: 1, lastRunAt: null, nextRunAt: null },
    },
  },
  health: { downloadClients: [], arrInstances: [] },
  timeframeHours: 24,
  generatedAt: '2025-01-15T12:00:00Z',
};

describe('parseStatsV2', () => {
  it('maps the v2 response', () => {
    const s = parseStatsV2(V2_RESPONSE);
    expect(s.events).toBe(60);
    expect(s.strikes).toBe(24);
    expect(s.itemsRemoved).toBe(13);      // removals.total, not the old strikes.itemsRemoved
    expect(s.failedJobs).toBe(3);         // jobs.failed, reported by the server
    expect(s.jobs).toEqual([
      { name: 'QueueCleaner', totalRuns: 48, failed: 2 },
      { name: 'MalwareBlocker', totalRuns: 48, failed: 1 },
    ]);
  });

  it('reads no counts from the removed v1 shape', () => {
    const v1 = {
      events: { totalCount: 41 },
      strikes: { totalCount: 12, itemsRemoved: 3 },
      jobs: { byType: { QueueCleaner: { totalRuns: 288, failed: 0 } } },
    };
    const s = parseStatsV2(v1);
    expect(s.events).toBe(0);
    expect(s.strikes).toBe(0);
    expect(s.itemsRemoved).toBe(0);
    expect(s.jobs).toEqual([{ name: 'QueueCleaner', totalRuns: 0, failed: 0 }]);
  });

  it('survives an empty or partial payload', () => {
    expect(parseStatsV2({})).toEqual({ events: 0, strikes: 0, itemsRemoved: 0, jobs: [], failedJobs: 0 });
    expect(parseStatsV2(null).events).toBe(0);
    expect(parseStatsV2({ jobs: { byType: { Seeker: {} } } }).failedJobs).toBe(0);
  });
});

describe('describeCleanuparr', () => {
  it('reports a working connection', () => {
    expect(describeCleanuparr('ok', 200, true)).toEqual(
      { text: 'Connected', sub: 'Stats and strikes available', tone: 'ok' });
  });

  it('names the key for 401 and 403', () => {
    for (const code of [401, 403]) {
      const d = describeCleanuparr('unauthorized', code, true);
      expect(d.text).toBe('API key rejected');
      expect(d.sub).toBe(`Check CLEANUPARR_API_KEY (HTTP ${code})`);
      expect(d.tone).toBe('bad');
    }
  });

  it('names the version for 404 and shows the code', () => {
    const d = describeCleanuparr('unsupported', 404, true);
    expect(d.text).toBe('Unsupported Cleanuparr version');
    expect(d.sub).toBe('No /api/v2/stats (HTTP 404) — update Cleanuparr');
    expect(d.tone).toBe('bad');
  });

  it('points at the URL when a known Cleanuparr stops answering', () => {
    const d = describeCleanuparr('unreachable', 502, true);
    expect(d.text).toBe('Not reachable');
    expect(d.sub).toBe('Check CLEANUPARR_URL and the container (HTTP 502)');
    expect(d.tone).toBe('warn');
  });

  it('only suggests setting the URL when it never answered', () => {
    const d = describeCleanuparr('unreachable', 502, false);
    expect(d.text).toBe('Not connected');
    expect(d.sub).toBe('Optional — set CLEANUPARR_URL to enable');
    expect(d.tone).toBe('idle');
    // a rejected key must never be reported as a missing URL
    expect(describeCleanuparr('unauthorized', 401, false).sub).not.toContain('CLEANUPARR_URL');
  });

  it('omits the code when the request never got one', () => {
    expect(describeCleanuparr('unreachable', null, true).sub)
      .toBe('Check CLEANUPARR_URL and the container');
  });

  it('says nothing before the first answer', () => {
    expect(describeCleanuparr('unknown', null, false))
      .toEqual({ text: 'Checking …', sub: '', tone: 'idle' });
  });
});

describe('indexEvents', () => {
  it('keeps the newest event per hash and ignores those without one', () => {
    const map = indexEvents({ items: [
      { itemHash: 'ABC', strikeCount: 2, eventType: 'StalledStrike', timestamp: 't2', cleanReason: 'Stalled' },
      { itemHash: 'abc', strikeCount: 1, eventType: 'StalledStrike', timestamp: 't1' },
      { itemHash: null, eventType: 'SearchTriggered', timestamp: 't0' },
    ] });
    expect(map.size).toBe(1);
    expect(map.get('abc')).toEqual(jasmine.objectContaining({
      strikes: 2, eventType: 'Stalled strike', reason: 'Stalled', at: 't2',
    }));
  });
});
