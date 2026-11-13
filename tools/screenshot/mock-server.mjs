// Throwaway mock of the qBittorrent API + static server for the README screenshots.
// Demo data, so no real torrents end up in the repo.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const DIST = process.argv[2];
const PORT = 8091;

const GB = 1024 ** 3;
const t = (name, cat, size, prog, state, dl, up, seeds, peers, ratio, path, added) => ({
  name, category: cat, size, completed: Math.round(size * prog), progress: prog,
  state, dlspeed: dl, upspeed: up, num_seeds: seeds, num_leechs: peers, ratio,
  save_path: path, added_on: added, tags: '', time_active: 262800,
  tracker: 'https://tracker.example.org/announce',
  eta: dl > 0 ? Math.round((size * (1 - prog)) / dl) : 8640000,
  magnet_uri: 'magnet:?xt=urn:btih:demo',
});

const TORRENTS = {
  h1: t('Blender.Open.Movie.Sintel.2010.1080p.BluRay.x265-DEMO', 'radarr', 35.6 * GB, 0.58, 'downloading', 86630, 0, 12, 34, 0.00, '/downloads/movies', 1754380140),
  h2: t('Big.Buck.Bunny.2008.2160p.WEB-DL.H.265-DEMO', 'radarr', 16.1 * GB, 1, 'uploading', 0, 484556, 3, 263, 1.24, '/downloads/movies', 1751350140),
  h3: t('Cosmos.Laundromat.2015.1080p.WEB-DL.AV1-DEMO', 'radarr', 2.6 * GB, 1, 'uploading', 0, 121242, 2, 41, 0.55, '/downloads/movies', 1749140140),
  h4: t('Tears.of.Steel.S01-S02.1080p.BluRay.x264-DEMO', 'tv-sonarr', 7.5 * GB, 1, 'uploading', 0, 96420, 4, 87, 0.27, '/downloads/tv', 1747140140),
  h5: t('Caminandes.Complete.Series.1080p.WEB-DL.x265-DEMO', 'tv-sonarr', 6.1 * GB, 1, 'uploading', 0, 42130, 2, 19, 0.45, '/downloads/tv', 1745140140),
  h6: t('Spring.2019.1080p.WEB-DL.DDP5.1.x264-DEMO', 'radarr', 5.2 * GB, 0.34, 'stalledDL', 0, 0, 0, 0, 0.07, '/downloads/movies', 1744140140),
  h7: t('Agent.327.Operation.Barbershop.1080p.BluRay-DEMO', 'radarr', 2.3 * GB, 0.12, 'pausedDL', 0, 0, 0, 0, 0.00, '/downloads/movies', 1743140140),
  h8: t('Hero.2018.Grease.Pencil.Demo.1080p.WEB-DL-DEMO', 'tv-sonarr', 1.7 * GB, 0, 'queuedDL', 0, 0, 0, 0, 0.00, '/downloads/tv', 1742140140),
  // waiting for metadata: no size, no peers, nothing moving
  h9: t('Glass.Half.2015.Demo.Short.WEB-DL-DEMO', 'tv-sonarr', 0, 0, 'metaDL', 0, 0, 0, 0, 0.00, '/downloads/tv', 1741140140),
};

const MAINDATA = {
  rid: 1,
  full_update: true,
  torrents: TORRENTS,
  categories: {
    radarr: { name: 'radarr', savePath: '/downloads/movies' },
    'tv-sonarr': { name: 'tv-sonarr', savePath: '/downloads/tv' },
    prowlarr: { name: 'prowlarr', savePath: '/downloads' },
  },
  server_state: { dl_info_speed: 86630, up_info_speed: 605798, free_space_on_disk: 1363512524341 },
};

const FILES = [
  { name: 'Sintel/Sintel.S01E01.1080p.mkv', size: 4.2 * GB, progress: 1 },
  { name: 'Sintel/Sintel.S01E02.1080p.mkv', size: 4.4 * GB, progress: 1 },
  { name: 'Sintel/Sintel.S01E03.1080p.mkv', size: 4.1 * GB, progress: 0.62 },
  { name: 'Sintel/Sintel.S01E04.1080p.mkv', size: 4.3 * GB, progress: 0 },
];

const TRACKERS = [
  { url: '** [DHT] **', status: 2, num_peers: 34, msg: '' },
  { url: '** [PeX] **', status: 2, num_peers: 12, msg: '' },
  { url: 'https://tracker.example.org/announce', status: 2, num_peers: 34, msg: '' },
  { url: 'https://backup.example.net/announce', status: 4, num_peers: 0, msg: '' },
];

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.ico': 'image/x-icon', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.ttf': 'font/ttf' };

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const json = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  const text = (s) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(s); };

  if (p === '/api/v2/sync/maindata') return json(MAINDATA);
  if (p === '/api/v2/app/version') return text('5.0.4');
  if (p === '/api/v2/app/defaultSavePath') return text('/downloads');
  if (p === '/api/v2/transfer/speedLimitsMode') return text('0');
  if (p === '/api/v2/transfer/downloadLimit') return text('0');
  if (p === '/api/v2/transfer/uploadLimit') return text('0');
  if (p === '/api/v2/torrents/files') return json(FILES);
  if (p === '/api/v2/torrents/trackers') return json(TRACKERS);

  // Cleanuparr is only mocked when CLEANUPARR=1, so the default screenshots
  // show the app as it looks without the optional integration.
  if (p === '/cleanuparr/api/events') {
    if (!process.env['CLEANUPARR']) { res.writeHead(502); return res.end('no cleanuparr'); }
    return json({ items: [
      { itemHash: 'h6', strikeCount: 2, eventType: 'StrikeAdded', severity: 'Warning',
        timestamp: '2026-08-19T06:12:44Z', message: 'Strike added', deleteReason: null,
        cleanReason: 'Stalled for longer than the configured limit', failedImportReasons: [] },
      { itemHash: 'h1', strikeCount: 0, eventType: 'SearchTriggered', severity: 'Information',
        timestamp: '2026-08-19T05:40:02Z', message: 'Search triggered', failedImportReasons: [] },
    ] });
  }

  // Mirrors current Cleanuparr: v1 /api/stats is gone, v2 is the live one.
  if (p === '/cleanuparr/api/stats') { res.writeHead(404); return res.end('not found'); }

  if (p === '/cleanuparr/api/v2/stats') {
    if (!process.env['CLEANUPARR']) { res.writeHead(502); return res.end('no cleanuparr'); }
    if (process.env['CLEANUPARR'] === 'badkey') { res.writeHead(401); return res.end('unauthorized'); }
    if (process.env['CLEANUPARR'] === 'old') { res.writeHead(404); return res.end('not found'); }
    return json({
      events: { total: 41, byType: {}, bySeverity: {} },
      strikes: { total: 12, byType: {}, recovered: 2 },
      removals: { total: 3, byReason: { Stalled: 2, FailedImport: 1 } },
      cleaned: { total: 1, byReason: {} },
      searches: { total: 4, completed: 4, failed: 0, grabbed: 2, byReason: {} },
      jobs: { total: 600, completed: 600, failed: 0, byType: {
        QueueCleaner: { total: 288, completed: 288, failed: 0 },
        MalwareBlocker: { total: 288, completed: 288, failed: 0 },
        Seeker: { total: 24, completed: 24, failed: 0 },
      } },
      health: { downloadClients: [], arrInstances: [] },
      timeframeHours: 24,
      generatedAt: new Date().toISOString(),
    });
  }

  if (p.startsWith('/api/')) return text('Ok.');

  // static from dist/, else index.html (SPA fallback)
  let file = join(DIST, p === '/' ? 'index.html' : p);
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(await readFile(join(DIST, 'index.html')));
  }
}).listen(PORT, () => console.log('mock on ' + PORT));
