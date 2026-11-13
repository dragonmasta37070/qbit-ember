import { Component, computed, effect, inject, signal } from '@angular/core';
import { QbitApiService, STATE_COLOR, STATE_LABEL, Torrent, TorrentFile, Tracker, UiState } from './qbit-api.service';
import { fmtBytes, fmtDate, fmtEta, fmtIsoDate, fmtRatio, fmtSpeed, techLine } from './format';
import { CleanuparrService, describeCleanuparr } from './cleanuparr.service';
import { buildAttention } from './attention';

type Filter = 'attention' | 'active' | 'all' | 'down' | 'done' | 'paused' | 'seeding' | 'completed' | 'stalled' | 'error';
type Sort = 'status' | 'name' | 'size' | 'progress';
export type Theme = 'light' | 'dark' | 'auto';

const FILTER_LABEL: Record<Filter, string> = {
  attention: 'Attention',
  active: 'Active', all: 'All', down: 'Downloading', done: 'Complete', paused: 'Queued',
  seeding: 'Seeding', completed: 'Complete', stalled: 'Stalled', error: 'Error',
};
const SORT_LABEL: Record<Sort, string> = {
  status: 'Status', name: 'Name', size: 'Size', progress: 'Progress',
};

const FILTER_FN: Record<Filter, (t: Torrent) => boolean> = {
  attention: needsAttention,
  all: () => true,
  active: t => t.dlspeed > 0 || t.upspeed > 0 || t.state === 'downloading' || t.state === 'metadata',
  down: t => t.state === 'downloading' || t.state === 'stalled',
  done: t => t.state === 'completed' || t.state === 'seeding',
  paused: t => t.state === 'queued' || t.state === 'paused',
  seeding: t => t.state === 'seeding',
  completed: t => t.state === 'completed',
  stalled: t => t.state === 'stalled',
  error: t => t.state === 'error',
};

// sidebar state-dot colour per filter (design §7)
const FILTER_DOT: Record<Filter, string> = {
  attention: '--warn',
  all: '--t3', active: '--dl', down: '--dl', done: '--ok', paused: '--t3',
  seeding: '--ok', completed: '--ok', stalled: '--warn', error: '--bad',
};

// ponytail: fixed rank stands in for the prototype's "curated server order"
const STATE_RANK: Record<UiState, number> = {
  error: 0, downloading: 1, metadata: 2, stalled: 3, queued: 4, paused: 5, seeding: 6, completed: 7,
};

const RING_C = 87.96; // 2π·14 — 34px ring, 3px stroke (design/README.md)
const NO_CAT = '__none__';
const NO_TAG = '__none__';
const PUSH_MS = 300;  // push-screen animation (design motion table)
const SHEET_MS = 340; // sheet up/down
// ponytail: a download at 0 B/s is normal for a moment; half an hour is not.
// Raise it if your trackers are slow to warm up.
const STUCK_AFTER_S = 1800;

/** A download that says it is running but has not moved a byte in a while. */
function isStuck(t: Torrent): boolean {
  return (t.state === 'downloading' || t.state === 'metadata')
    && t.dlspeed === 0
    && t.timeActive > STUCK_AFTER_S;
}

/** Exactly what the attention line is talking about, so tapping it can show them. */
function needsAttention(t: Torrent): boolean {
  return t.state === 'error' || t.state === 'stalled' || isStuck(t);
}

interface Behave { resume: boolean; notify: boolean; wifi: boolean; }

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css',
})
export class AppComponent {
  readonly api = inject(QbitApiService);
  readonly cleanuparr = inject(CleanuparrService);

  // re-exported for the template
  readonly STATE_LABEL = STATE_LABEL;
  readonly STATE_COLOR = STATE_COLOR;
  readonly FILTER_LABEL = FILTER_LABEL;
  readonly SORT_LABEL = SORT_LABEL;
  readonly FILTER_DOT = FILTER_DOT;
  readonly RING_C = RING_C;
  readonly NO_CAT = NO_CAT;
  readonly NO_TAG = NO_TAG;
  private readonly baseFilters: Filter[] = ['active', 'all', 'down', 'done', 'paused'];
  private readonly baseSideFilters: Filter[] =
    ['active', 'all', 'down', 'seeding', 'completed', 'paused', 'stalled', 'error'];
  readonly sorts: Sort[] = ['status', 'name', 'size', 'progress'];
  readonly themes: Theme[] = ['light', 'dark', 'auto'];
  readonly THEME_LABEL: Record<Theme, string> = { light: 'Light', dark: 'Dark', auto: 'Automatic' };
  readonly dtabs = ['info', 'files', 'trackers'] as const;
  readonly DTAB_LABEL = { info: 'Info', files: 'Files', trackers: 'Trackers' };
  readonly fmtBytes = fmtBytes;
  readonly fmtSpeed = fmtSpeed;
  readonly fmtRatio = fmtRatio;
  readonly fmtEta = fmtEta;
  readonly fmtDate = fmtDate;
  readonly fmtIsoDate = fmtIsoDate;
  readonly isStuck = isStuck;
  readonly host = location.host;

  // ── State (design/README.md "State") ─────────────────────
  readonly screen = signal<'list' | 'detail' | 'settings' | 'cleanuparr'>('list');
  readonly closing = signal(false);            // push-screen exit animation
  readonly dtab = signal<'info' | 'files' | 'trackers'>('info');
  readonly filter = signal<Filter>('active');
  readonly sideFilter = signal<Filter>('active');
  readonly catFilter = signal<string | null>(null);   // desktop sidebar
  readonly tagFilter = signal<string | null>(null);
  readonly sort = signal<Sort>('status');
  readonly dir = signal<1 | -1>(1);
  readonly menu = signal<null | 'filter' | 'sort' | 'sort-desktop'>(null);
  readonly q = signal('');
  readonly sel = signal<string | null>(null);
  readonly sheet = signal<null | 'add' | 'del'>(null);
  readonly sheetClosing = signal(false);
  readonly sheetDragY = signal(0);
  readonly sheetDragging = signal(false);
  readonly delTarget = signal<Torrent | null>(null);
  readonly delFiles = signal(false);
  readonly magnet = signal('');
  readonly addCat = signal('');                // '' = none
  readonly startNow = signal(true);
  readonly open = signal<string | null>(null); // swipe-open row hash
  readonly dragX = signal(0);                  // live drag offset of drag target
  readonly dragging = signal<string | null>(null);
  readonly toastMsg = signal('');
  readonly theme = signal<Theme>((localStorage.getItem('theme') as Theme) ?? 'auto');
  readonly isDesktop = signal(matchMedia('(min-width: 900px)').matches);
  // ponytail: the three behaviour switches are pure UI preferences, localStorage only
  readonly behave = signal<Behave>(JSON.parse(localStorage.getItem('behave') ?? '{"resume":true,"notify":false,"wifi":false}'));

  readonly files = signal<TorrentFile[]>([]);
  readonly trackers = signal<Tracker[]>([]);

  readonly loginUser = signal('');
  readonly loginPass = signal('');

  /** 'Needs attention' is listed only while it has something in it, or while it
   *  is the current filter — an always-present entry reading 0 is just noise. */
  readonly filters = computed(() =>
    this.counts()['attention'] > 0 || this.filter() === 'attention'
      ? ['attention', ...this.baseFilters] as Filter[]
      : this.baseFilters);

  readonly sideFilters = computed(() =>
    this.counts()['attention'] > 0 || this.sideFilter() === 'attention'
      ? ['attention', ...this.baseSideFilters] as Filter[]
      : this.baseSideFilters);

  readonly counts = computed(() => {
    const list = this.api.torrents();
    const out = {} as Record<Filter, number>;
    for (const f of Object.keys(FILTER_FN) as Filter[]) out[f] = list.filter(FILTER_FN[f]).length;
    return out;
  });

  readonly catCounts = computed(() => {
    const m = new Map<string, number>();
    for (const c of this.api.categories()) m.set(c, 0);
    let none = 0;
    for (const t of this.api.torrents()) {
      if (t.category) m.set(t.category, (m.get(t.category) ?? 0) + 1);
      else none++;
    }
    return { cats: [...m.entries()], none };
  });

  readonly tagCounts = computed(() => {
    const m = new Map<string, number>();
    let none = 0;
    for (const t of this.api.torrents()) {
      const tags = t.tags.split(',').map(s => s.trim()).filter(Boolean);
      if (!tags.length) none++;
      for (const tag of tags) m.set(tag, (m.get(tag) ?? 0) + 1);
    }
    return { tags: [...m.entries()], none };
  });

  readonly visible = computed(() => {
    const q = this.q().trim().toLowerCase();
    const desktop = this.isDesktop();
    let list = this.api.torrents().filter(FILTER_FN[desktop ? this.sideFilter() : this.filter()]);
    if (desktop) {
      const cat = this.catFilter();
      if (cat !== null) list = list.filter(t => (cat === NO_CAT ? !t.category : t.category === cat));
      const tag = this.tagFilter();
      if (tag !== null) {
        list = list.filter(t => {
          const tags = t.tags.split(',').map(s => s.trim()).filter(Boolean);
          return tag === NO_TAG ? !tags.length : tags.includes(tag);
        });
      }
    }
    if (q) list = list.filter(t => t.name.toLowerCase().includes(q) || t.category.toLowerCase().includes(q));
    const s = this.sort();
    list = [...list].sort((a, b) =>
      s === 'name' ? a.name.localeCompare(b.name, 'en')
      : s === 'size' ? b.size - a.size
      : s === 'progress' ? b.progress - a.progress
      : STATE_RANK[a.state] - STATE_RANK[b.state] || a.name.localeCompare(b.name, 'en'));
    return this.dir() === -1 ? list.reverse() : list;
  });

  // desktop detail column: selection or first visible
  readonly selected = computed(() => {
    const hash = this.sel();
    const list = this.visible();
    return list.find(t => t.hash === hash) ?? list[0] ?? null;
  });

  // mobile detail screen: live view of the selected torrent, independent of filters
  readonly detailTorrent = computed(() => {
    const hash = this.sel();
    return this.api.torrents().find(t => t.hash === hash) ?? null;
  });

  // one line above the list, absent when nothing needs attention
  readonly attention = computed(() => {
    const list = this.api.torrents();
    const cp = this.cleanuparr.stats();
    return buildAttention({
      errors: list.filter(t => t.state === 'error').length,
      stalled: list.filter(t => t.state === 'stalled').length,
      stuck: list.filter(isStuck).length,
      freeSpace: this.api.server().freeSpace,
      cleanuparr: this.cleanuparr.configured()
        ? {
            status: this.cleanuparr.status(),
            failedJobs: cp?.failedJobs ?? 0,
            itemsRemoved: cp?.itemsRemoved ?? 0,
          }
        : null,
    });
  });

  readonly cleanuparrLabel = computed(() =>
    describeCleanuparr(this.cleanuparr.status(), this.cleanuparr.httpStatus(), this.cleanuparr.configured()));

  // Cleanuparr context for the torrent on the detail screen, if it knows it
  readonly detailCleanuparr = computed(() => {
    const t = this.detailTorrent();
    if (!t || !this.cleanuparr.reachable()) return null;
    return this.cleanuparr.items().get(t.hash.toLowerCase()) ?? null;
  });

  // add sheet: derived save path (design §4 "ZIEL")
  readonly addSavePath = computed(() =>
    (this.addCat() ? this.api.catPaths()[this.addCat()] : '') || this.api.defaultSavePath() || '–');

  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private mql = matchMedia('(prefers-color-scheme: dark)');

  constructor() {
    effect(() => this.applyTheme(this.theme()));
    effect(() => localStorage.setItem('behave', JSON.stringify(this.behave())));
    this.mql.addEventListener('change', () => this.applyTheme(this.theme()));
    const dq = matchMedia('(min-width: 900px)');
    dq.addEventListener('change', e => this.isDesktop.set(e.matches));
  }

  private applyTheme(t: Theme): void {
    localStorage.setItem('theme', t);
    const dark = t === 'dark' || (t === 'auto' && this.mql.matches);
    document.documentElement.dataset['theme'] = dark ? 'dark' : 'light';
  }

  toast(msg: string): void {
    this.toastMsg.set(msg);
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toastMsg.set(''), 1800);
  }

  techLine(t: Torrent): string { return techLine(t.name, t.size, t.category); }

  pct(t: Torrent): string { return `${Math.round(t.progress * 100)}%`; }

  shortTitle(t: Torrent): string {
    const clean = t.name.replace(/[._]/g, ' ');
    return clean.length > 32 ? clean.slice(0, 32) + '…' : clean;
  }

  trackerHost(t: Torrent): string {
    try { return new URL(t.tracker).hostname; } catch { return t.tracker || '–'; }
  }

  fileName(f: TorrentFile): string {
    return f.name.split('/').pop() ?? f.name;
  }

  statusDetail(t: Torrent): string {
    // A torrent that claims to be running but has not moved is the case this
    // line exists for. How long it has been that way is the useful part —
    // 0 KB/s and ETA ∞ told the user nothing.
    if (t.state === 'metadata') return `for ${fmtEta(t.timeActive)}`;
    if (isStuck(t)) return `stuck for ${fmtEta(t.timeActive)}`;
    switch (t.state) {
      // ponytail: no percentage here — the progress ring next to it already shows it,
      // and the English labels are long enough to truncate the line on a narrow phone
      case 'downloading':
        return `↓ ${fmtSpeed(t.dlspeed)} · ETA ${fmtEta(t.eta)}`;
      case 'seeding': return `↑ ${fmtSpeed(t.upspeed)} · ${t.peers} peers`;
      case 'completed': return `Ratio ${fmtRatio(t.ratio)}`;
      case 'queued': return 'In queue';
      case 'stalled': return 'No connection to peers';
      case 'paused': return `${fmtBytes(t.completed)} downloaded`;
      case 'error': return 'Error';
    }
    return '';
  }

  limitLabel(bytesPerSec: number): string {
    return bytesPerSec > 0 ? fmtSpeed(bytesPerSec) : '∞';
  }

  // ── Navigation (push 300ms) ──────────────────────────────
  pushScreen(s: 'detail' | 'settings' | 'cleanuparr'): void {
    this.closing.set(false);
    this.screen.set(s);
    if (s === 'settings') void this.api.fetchSettings();
  }

  back(): void {
    // Cleanuparr is pushed from settings, so it pops back there, not to the list
    const target = this.screen() === 'cleanuparr' ? 'settings' : 'list';
    this.closing.set(true);
    setTimeout(() => { this.screen.set(target); this.closing.set(false); }, PUSH_MS);
  }

  // ── Swipe (open −152, threshold −70, max −176, <5px = tap) ──
  private startX = 0;
  private startY = 0;
  private baseX = 0;
  private moved = false;
  private horizontal: boolean | null = null;

  onPointerDown(ev: PointerEvent, t: Torrent): void {
    this.menu.set(null);
    this.startX = ev.clientX;
    this.startY = ev.clientY;
    this.baseX = this.open() === t.hash ? -152 : 0;
    this.moved = false;
    this.horizontal = null;
    this.dragging.set(t.hash);
    this.dragX.set(this.baseX);
  }

  onPointerMove(ev: PointerEvent, t: Torrent): void {
    if (this.dragging() !== t.hash) return;
    const dx = ev.clientX - this.startX;
    const dy = ev.clientY - this.startY;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) this.moved = true;
    if (this.horizontal === null && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) {
      this.horizontal = Math.abs(dx) > Math.abs(dy);
      if (this.horizontal) (ev.target as Element).setPointerCapture?.(ev.pointerId);
    }
    if (!this.horizontal) return;
    this.dragX.set(Math.min(0, Math.max(-176, this.baseX + dx)));
  }

  onPointerUp(t: Torrent): void {
    if (this.dragging() !== t.hash) return;
    this.dragging.set(null);
    if (!this.moved) {
      // tap: open row closes it, otherwise navigate to detail
      if (this.open()) { this.open.set(null); return; }
      this.openDetail(t);
      return;
    }
    this.open.set(this.dragX() < -70 ? t.hash : null);
  }

  rowOffset(t: Torrent): number {
    if (this.dragging() === t.hash && this.horizontal) return this.dragX();
    return this.open() === t.hash ? -152 : 0;
  }

  openDetail(t: Torrent): void {
    this.sel.set(t.hash);
    this.dtab.set('info');
    this.files.set([]);
    this.trackers.set([]);
    this.pushScreen('detail');
  }

  pickDtab(tab: 'info' | 'files' | 'trackers'): void {
    this.dtab.set(tab);
    const t = this.detailTorrent();
    if (!t) return;
    if (tab === 'files' && !this.files().length) void this.api.files(t.hash).then(f => this.files.set(f));
    if (tab === 'trackers' && !this.trackers().length) void this.api.trackers(t.hash).then(tr => this.trackers.set(tr));
  }

  async togglePause(t: Torrent): Promise<void> {
    this.open.set(null);
    if (t.state === 'paused') {
      await this.api.resume(t.hash);
      this.toast('Resumed');
    } else {
      await this.api.pause(t.hash);
      this.toast('Paused');
    }
  }

  async reannounce(t: Torrent): Promise<void> {
    await this.api.reannounce(t.hash);
    this.toast('Reannounced');
  }

  async share(t: Torrent): Promise<void> {
    const link = t.magnetUri || t.name;
    if (navigator.share) {
      try { await navigator.share({ title: t.name, url: t.magnetUri || undefined, text: t.magnetUri ? undefined : t.name }); } catch { /* cancelled */ }
    } else {
      await navigator.clipboard.writeText(link);
      this.toast('Link copied');
    }
  }

  askDelete(t: Torrent): void {
    this.open.set(null);
    this.delTarget.set(t);
    this.delFiles.set(false);
    this.sheet.set('del');
  }

  async confirmDelete(): Promise<void> {
    const t = this.delTarget();
    if (!t) return;
    const withFiles = this.delFiles();
    await this.api.delete(t.hash, withFiles);
    this.sheet.set(null);
    this.delTarget.set(null);
    if (this.sel() === t.hash) this.sel.set(null);
    if (this.screen() === 'detail') this.back();
    this.toast(withFiles ? 'Torrent and files deleted' : 'Torrent removed');
  }

  // ── Add sheet (design §4) ────────────────────────────────
  openAdd(): void {
    this.magnet.set('');
    this.addCat.set('');
    this.startNow.set(true);
    this.sheetClosing.set(false);
    this.sheetDragY.set(0);
    this.sheet.set('add');
    if (!this.api.defaultSavePath()) void this.api.fetchSettings();
  }

  closeSheet(): void {
    this.sheetClosing.set(true);
    this.sheetDragY.set(window.innerHeight);
    setTimeout(() => {
      this.sheet.set(null);
      this.sheetClosing.set(false);
      this.sheetDragY.set(0);
    }, SHEET_MS);
  }

  // ── Swipe the sheet down to dismiss ──────────────────────
  private sheetStartY = 0;

  onSheetDown(ev: PointerEvent): void {
    this.sheetStartY = ev.clientY;
    this.sheetDragging.set(true);
    (ev.target as Element).setPointerCapture?.(ev.pointerId);
  }

  onSheetMove(ev: PointerEvent): void {
    if (!this.sheetDragging()) return;
    this.sheetDragY.set(Math.max(0, ev.clientY - this.sheetStartY));
  }

  onSheetUp(): void {
    if (!this.sheetDragging()) return;
    this.sheetDragging.set(false);
    if (this.sheetDragY() > 110) this.closeSheet();
    else this.sheetDragY.set(0);
  }

  async confirmAdd(): Promise<void> {
    const magnet = this.magnet().trim();
    if (!magnet) {
      this.toast('Magnet link missing');
      return;
    }
    const ok = await this.api.add(magnet, this.addCat(), this.startNow());
    this.closeSheet();
    this.toast(ok ? 'Torrent added' : 'Adding failed');
  }

  toggleBehave(key: keyof Behave): void {
    this.behave.update(b => ({ ...b, [key]: !b[key] }));
  }

  // Tapping the attention line: either surface the problem torrents (sorting by
  // status already ranks errors first) or open the settings screen.
  followAttention(): void {
    const a = this.attention();
    if (a.action === 'settings') { this.pushScreen('settings'); return; }
    if (a.action !== 'torrents') return;
    this.q.set('');
    this.sort.set('status');
    this.dir.set(1);
    if (this.isDesktop()) { this.sideFilter.set('attention'); this.catFilter.set(null); this.tagFilter.set(null); }
    else this.filter.set('attention');
  }

  toggleMenu(which: 'filter' | 'sort' | 'sort-desktop'): void {
    this.menu.set(this.menu() === which ? null : which);
  }

  pickFilter(f: Filter): void { this.filter.set(f); this.menu.set(null); }
  pickSort(s: Sort): void { this.sort.set(s); this.menu.set(null); }
  flipDir(): void { this.dir.set(this.dir() === 1 ? -1 : 1); }

  pickSideFilter(f: Filter): void { this.sideFilter.set(f); }
  pickCat(c: string | null): void { this.catFilter.set(this.catFilter() === c ? null : c); }
  pickTag(t: string | null): void { this.tagFilter.set(this.tagFilter() === t ? null : t); }

  async submitLogin(): Promise<void> {
    await this.api.login(this.loginUser(), this.loginPass());
  }
}
