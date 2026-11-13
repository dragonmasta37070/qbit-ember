import { fmtBytes } from './format';
import { CleanuparrStatus } from './cleanuparr.service';

// One line above the list that answers "does anything need me?".
// It is absent when the answer is no — a banner that is always there and
// always green stops being read after a day.

export type AttentionLevel = 'none' | 'info' | 'warn';

export interface Attention {
  level: AttentionLevel;
  text: string;
  /** where a tap should go: the problem torrents, or the settings screen */
  action: 'torrents' | 'settings' | null;
}

export interface AttentionInput {
  errors: number;
  stalled: number;
  /** downloading or fetching metadata, but nothing has moved for a while */
  stuck: number;
  freeSpace: number;
  /** null when Cleanuparr has never answered — it is optional, so its absence
   *  is never reported. */
  cleanuparr: {
    status: CleanuparrStatus;
    failedJobs: number;
    itemsRemoved: number;
  } | null;
}

// ponytail: fixed floor, not a percentage — free space alone doesn't tell us
// the disk size. Make it a setting if the number ever feels wrong.
const LOW_DISK = 50 * 1024 ** 3;

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

export function buildAttention(input: AttentionInput): Attention {
  const { errors, stalled, stuck, freeSpace, cleanuparr } = input;
  const torrentParts: string[] = [];
  const systemParts: string[] = [];

  if (errors > 0) torrentParts.push(plural(errors, 'error'));

  // Report stalled and stuck downloads even when Cleanuparr is watching them.
  // Suppressing them left the list looking healthy while nothing moved, which
  // is exactly the blind spot this line exists to close — the detail screen is
  // where "Cleanuparr is already on it" belongs.
  if (stalled > 0) torrentParts.push(`${stalled} stalled`);
  if (stuck > 0) torrentParts.push(`${stuck} stuck`);

  if (freeSpace > 0 && freeSpace < LOW_DISK) systemParts.push(`only ${fmtBytes(freeSpace)} free`);

  if (cleanuparr?.status === 'unauthorized') {
    systemParts.push('Cleanuparr key rejected');
  } else if (cleanuparr?.status === 'unsupported') {
    systemParts.push('Cleanuparr version unsupported');
  } else if (cleanuparr?.status === 'unreachable') {
    systemParts.push('Cleanuparr unreachable');
  } else if (cleanuparr?.status === 'ok' && cleanuparr.failedJobs > 0) {
    systemParts.push(`${plural(cleanuparr.failedJobs, 'Cleanuparr job')} failed`);
  }

  const parts = [...torrentParts, ...systemParts];
  if (parts.length) {
    return {
      level: 'warn',
      text: parts.join(' · '),
      action: torrentParts.length ? 'torrents' : 'settings',
    };
  }

  if (cleanuparr?.status === 'ok' && cleanuparr.itemsRemoved > 0) {
    return {
      level: 'info',
      text: `Cleanuparr removed ${plural(cleanuparr.itemsRemoved, 'download')}`,
      action: 'settings',
    };
  }

  return { level: 'none', text: '', action: null };
}
