import { Injectable, computed, signal } from '@angular/core';

// ── UI state model (design/README.md "Screens" §1) ─────────────────────────
export type UiState = 'downloading' | 'metadata' | 'seeding' | 'completed' | 'queued' | 'stalled' | 'paused' | 'error';

export const STATE_LABEL: Record<UiState, string> = {
  downloading: 'Downloading', metadata: 'Fetching metadata', seeding: 'Seeding',
  completed: 'Complete', queued: 'Queued', stalled: 'Stalled', paused: 'Paused', error: 'Error',
};

// token name of the state colour — resolved in CSS via var()
export const STATE_COLOR: Record<UiState, string> = {
  downloading: '--dl', metadata: '--dl', seeding: '--ok', completed: '--ok',
  queued: '--t3', stalled: '--warn', paused: '--warn', error: '--bad',
};

export interface Torrent {
  hash: string;
  name: string;
  size: number;
  completed: number;
  progress: number;      // 0..1
  state: UiState;
  rawState: string;
  dlspeed: number;
  upspeed: number;
  eta: number;
  seeds: number;
  peers: number;
  ratio: number;
  category: string;
  tags: string;
  savePath: string;
  addedOn: number;
  tracker: string;
  timeActive: number;
  magnetUri: string;
}

export interface ServerState {
  dlSpeed: number;
  upSpeed: number;
  freeSpace: number;
  version: string;
}

export interface TorrentFile { name: string; size: number; progress: number; }
export interface Tracker { url: string; status: number; peers: number; msg: string; }

function mapState(s: string): UiState {
  switch (s) {
    case 'downloading': case 'forcedDL': case 'allocating': case 'checkingDL':
      return 'downloading';
    // Still looking for the torrent's metadata: no size, no files, no progress.
    // Folding this into "downloading" made a stuck torrent look healthy.
    case 'metaDL': case 'forcedMetaDL':
      return 'metadata';
    case 'uploading': case 'forcedUP':
      return 'seeding';
    case 'stalledUP': case 'pausedUP': case 'stoppedUP': case 'checkingUP':
      return 'completed';
    case 'stalledDL':
      return 'stalled';
    case 'queuedDL': case 'queuedUP': case 'checkingResumeData':
      return 'queued';
    case 'pausedDL': case 'stoppedDL':
      return 'paused';
    case 'error': case 'missingFiles':
      return 'error';
    default:
      return 'queued';
  }
}

const POLL_MS = 1100; // matches the prototype / progress-bar animation (design/README.md)

@Injectable({ providedIn: 'root' })
export class QbitApiService {
  readonly auth = signal<'checking' | 'ok' | 'login'>('checking');
  readonly loginError = signal('');
  readonly torrents = signal<Torrent[]>([]);
  readonly server = signal<ServerState>({ dlSpeed: 0, upSpeed: 0, freeSpace: 0, version: '' });
  readonly categories = signal<string[]>([]);
  readonly catPaths = signal<Record<string, string>>({});
  readonly defaultSavePath = signal('');
  readonly altLimits = signal(false);
  readonly dlLimit = signal(0);   // bytes/s, 0 = unlimited
  readonly upLimit = signal(0);
  readonly connected = computed(() => this.auth() === 'ok');

  private rid = 0;
  private raw = new Map<string, Record<string, unknown>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  // qBittorrent 5.x renamed pause/resume → stop/start; detected on first use
  private legacyPauseNames: boolean | null = null;

  constructor() { this.start(); }

  start(): void {
    if (this.timer) return;
    void this.fetchVersion();
    void this.poll();
  }

  private async fetchVersion(): Promise<void> {
    const r = await fetch('/api/v2/app/version');
    if (!r.ok) return;
    const v = (await r.text()).replace(/^v/, '');
    this.server.update(s => ({ ...s, version: v }));
  }

  private async poll(): Promise<void> {
    try {
      const r = await fetch(`/api/v2/sync/maindata?rid=${this.rid}`);
      if (r.status === 403) {
        this.auth.set('login');
        this.timer = null;
        return;
      }
      if (r.ok) {
        this.applyMaindata(await r.json());
        if (this.auth() !== 'ok') {
          this.auth.set('ok');
          void this.fetchVersion();
        }
      }
    } catch {
      // network hiccup — keep polling
    }
    this.timer = setTimeout(() => void this.poll(), POLL_MS);
  }

  private applyMaindata(d: any): void {
    this.rid = d.rid ?? 0;
    if (d.full_update) this.raw.clear();
    for (const h of d.torrents_removed ?? []) this.raw.delete(h);
    for (const [h, patch] of Object.entries(d.torrents ?? {})) {
      this.raw.set(h, { ...(this.raw.get(h) ?? {}), ...(patch as object) });
    }
    if (d.categories || d.full_update) {
      const paths = { ...this.catPaths() };
      for (const [name, c] of Object.entries(d.categories ?? {})) paths[name] = (c as any).savePath ?? '';
      for (const c of d.categories_removed ?? []) delete paths[c];
      this.catPaths.set(paths);
      this.categories.set(Object.keys(paths).sort());
    }
    if (d.server_state) {
      const s = d.server_state;
      this.server.update(prev => ({
        ...prev,
        dlSpeed: s.dl_info_speed ?? prev.dlSpeed,
        upSpeed: s.up_info_speed ?? prev.upSpeed,
        freeSpace: s.free_space_on_disk ?? prev.freeSpace,
      }));
    }
    this.torrents.set([...this.raw.entries()].map(([hash, t]: [string, any]) => ({
      hash,
      name: t.name ?? '',
      size: t.size ?? 0,
      completed: t.completed ?? 0,
      progress: t.progress ?? 0,
      state: mapState(t.state ?? ''),
      rawState: t.state ?? '',
      dlspeed: t.dlspeed ?? 0,
      upspeed: t.upspeed ?? 0,
      eta: t.eta ?? 8640000,
      seeds: t.num_seeds ?? 0,
      peers: t.num_leechs ?? 0,
      ratio: t.ratio ?? 0,
      category: t.category ?? '',
      tags: t.tags ?? '',
      savePath: t.save_path ?? '',
      addedOn: t.added_on ?? 0,
      tracker: t.tracker ?? '',
      timeActive: t.time_active ?? 0,
      magnetUri: t.magnet_uri ?? '',
    })));
  }

  async fetchSettings(): Promise<void> {
    const get = async (p: string) => {
      const r = await fetch(`/api/v2/${p}`);
      return r.ok ? r.text() : '';
    };
    this.altLimits.set((await get('transfer/speedLimitsMode')) === '1');
    this.dlLimit.set(Number(await get('transfer/downloadLimit')) || 0);
    this.upLimit.set(Number(await get('transfer/uploadLimit')) || 0);
    this.defaultSavePath.set(await get('app/defaultSavePath'));
  }

  async toggleAltLimits(): Promise<void> {
    await this.post('transfer/toggleSpeedLimitsMode', {});
    this.altLimits.update(v => !v);
    await this.fetchSettings();
  }

  async login(username: string, password: string): Promise<boolean> {
    this.loginError.set('');
    const r = await fetch('/api/v2/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username, password }),
    });
    // qBittorrent 5.x answers a successful login with an empty 204 (a failed one with 401);
    // 4.x sends 200 with "Ok." or "Fails." in the body.
    const ok = r.status === 204 || (r.ok && (await r.text()).startsWith('Ok'));
    if (ok) {
      this.rid = 0;
      this.auth.set('ok');
      this.start();
    } else {
      this.loginError.set('Sign-in failed');
    }
    return ok;
  }

  private post(path: string, body: Record<string, string>): Promise<Response> {
    return fetch(`/api/v2/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
    });
  }

  private async pauseCall(action: 'stop' | 'start', hashes: string): Promise<void> {
    if (this.legacyPauseNames === null) {
      const r = await this.post(`torrents/${action}`, { hashes });
      this.legacyPauseNames = r.status === 404;
      if (!this.legacyPauseNames) return;
    }
    if (this.legacyPauseNames) {
      await this.post(`torrents/${action === 'stop' ? 'pause' : 'resume'}`, { hashes });
    } else {
      await this.post(`torrents/${action}`, { hashes });
    }
  }

  pause(hash: string): Promise<void> { return this.pauseCall('stop', hash); }
  resume(hash: string): Promise<void> { return this.pauseCall('start', hash); }

  async delete(hash: string, deleteFiles: boolean): Promise<void> {
    await this.post('torrents/delete', { hashes: hash, deleteFiles: String(deleteFiles) });
    this.raw.delete(hash);
    this.torrents.update(list => list.filter(t => t.hash !== hash));
  }

  // torrents/add requires multipart/form-data — urlencoded is silently dropped
  async add(magnet: string, category: string, startNow: boolean): Promise<boolean> {
    const fd = new FormData();
    fd.append('urls', magnet);
    if (category) fd.append('category', category);
    fd.append('stopped', String(!startNow));
    fd.append('paused', String(!startNow)); // pre-5.x name, ignored by 5.x
    const r = await fetch('/api/v2/torrents/add', { method: 'POST', body: fd });
    if (!r.ok) return false;
    this.rid = 0; // next poll returns a full_update containing the new torrent
    return !(await r.text()).startsWith('Fails');
  }

  async reannounce(hash: string): Promise<void> {
    await this.post('torrents/reannounce', { hashes: hash });
  }

  async files(hash: string): Promise<TorrentFile[]> {
    const r = await fetch(`/api/v2/torrents/files?hash=${hash}`);
    if (!r.ok) return [];
    return (await r.json()).map((f: any) => ({ name: f.name, size: f.size, progress: f.progress }));
  }

  async trackers(hash: string): Promise<Tracker[]> {
    const r = await fetch(`/api/v2/torrents/trackers?hash=${hash}`);
    if (!r.ok) return [];
    return (await r.json()).map((t: any) => ({
      url: t.url, status: t.status, peers: Math.max(t.num_peers ?? 0, 0), msg: t.msg ?? '',
    }));
  }
}
