import { buildAttention, AttentionInput } from './attention';

const base: AttentionInput = { errors: 0, stalled: 0, stuck: 0, freeSpace: 900 * 1024 ** 3, cleanuparr: null };
const cp = (o: Partial<NonNullable<AttentionInput['cleanuparr']>> = {}) =>
  ({ status: 'ok' as const, failedJobs: 0, itemsRemoved: 0, ...o });

describe('buildAttention', () => {
  it('stays silent when nothing is wrong and Cleanuparr is absent', () => {
    expect(buildAttention(base).level).toBe('none');
  });

  it('stays silent when Cleanuparr is present and idle', () => {
    expect(buildAttention({ ...base, cleanuparr: cp() }).level).toBe('none');
  });

  it('warns about errored torrents', () => {
    const a = buildAttention({ ...base, errors: 2 });
    expect(a.level).toBe('warn');
    expect(a.text).toBe('2 errors');
    expect(a.action).toBe('torrents');
  });

  it('warns about stalled torrents whether or not Cleanuparr is watching', () => {
    expect(buildAttention({ ...base, stalled: 3 }).text).toBe('3 stalled');
    expect(buildAttention({ ...base, stalled: 3, cleanuparr: cp() }).text).toBe('3 stalled');
  });

  it('warns about downloads that have stopped moving', () => {
    const a = buildAttention({ ...base, stuck: 1 });
    expect(a.text).toBe('1 stuck');
    expect(a.action).toBe('torrents');
  });

  it('reports an unsupported Cleanuparr version', () => {
    expect(buildAttention({ ...base, cleanuparr: cp({ status: 'unsupported' }) }).text)
      .toBe('Cleanuparr version unsupported');
  });

  it('tells a rejected key apart from an unreachable host', () => {
    expect(buildAttention({ ...base, cleanuparr: cp({ status: 'unauthorized' }) }).text)
      .toBe('Cleanuparr key rejected');
    expect(buildAttention({ ...base, cleanuparr: cp({ status: 'unreachable' }) }).text)
      .toBe('Cleanuparr unreachable');
  });

  it('warns when a configured Cleanuparr goes silent', () => {
    const a = buildAttention({ ...base, cleanuparr: cp({ status: 'unreachable' }) });
    expect(a.text).toBe('Cleanuparr unreachable');
    expect(a.action).toBe('settings');
  });

  it('warns about failed jobs, singular and plural', () => {
    expect(buildAttention({ ...base, cleanuparr: cp({ failedJobs: 1 }) }).text)
      .toBe('1 Cleanuparr job failed');
    expect(buildAttention({ ...base, cleanuparr: cp({ failedJobs: 4 }) }).text)
      .toBe('4 Cleanuparr jobs failed');
  });

  it('warns about low disk space', () => {
    expect(buildAttention({ ...base, freeSpace: 12 * 1024 ** 3 }).text).toBe('only 12.0 GB free');
  });

  it('combines warnings and prefers torrents as the tap target', () => {
    const a = buildAttention({ ...base, errors: 1, freeSpace: 12 * 1024 ** 3, cleanuparr: cp({ status: 'unreachable' }) });
    expect(a.text).toBe('1 error · only 12.0 GB free · Cleanuparr unreachable');
    expect(a.action).toBe('torrents');
  });

  it('reports cleanup only when nothing is wrong', () => {
    const quiet = buildAttention({ ...base, cleanuparr: cp({ itemsRemoved: 3 }) });
    expect(quiet.level).toBe('info');
    expect(quiet.text).toBe('Cleanuparr removed 3 downloads');
    expect(buildAttention({ ...base, errors: 1, cleanuparr: cp({ itemsRemoved: 3 }) }).level).toBe('warn');
  });
});
