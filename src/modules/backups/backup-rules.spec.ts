import { backupFilename, isDue, nextAutoAt, parseBackupFilename } from './backup-rules';

const on = (intervalDays: number) => ({ autoEnabled: true, intervalDays });
const off = { autoEnabled: false, intervalDays: 1 };

describe('backup names', () => {
  it('names a backup by its UTC time and what started it', () => {
    expect(backupFilename(new Date('2026-10-29T03:15:07.999Z'), 'auto')).toBe('slimshot-20261029-031507-auto.dump');
  });

  it('reads the time and trigger back from a name', () => {
    expect(parseBackupFilename('slimshot-20261029-031507-manual.dump')).toEqual({
      createdAt: new Date('2026-10-29T03:15:07Z'),
      trigger: 'manual',
    });
  });

  it('refuses anything that is not exactly a backup name', () => {
    for (const bad of [
      'notes.txt',
      'slimshot-20261029.dump',
      'slimshot-20261029-031507-auto.dump.bak',
      '../slimshot-20261029-031507-auto.dump',
      'postgres/slimshot-20261029-031507-auto.dump',
      'slimshot-20261029-031507-weekly.dump',
      'slimshot-20261399-031507-auto.dump',
      'slimshot-20261029-256199-auto.dump',
    ]) {
      expect(parseBackupFilename(bad)).toBeNull();
    }
  });
});

describe('when an automatic backup is due', () => {
  const last = new Date('2026-10-28T03:15:05Z');

  it('allows an hour of slack, so a run that ended at 03:15:05 does not push the next a day', () => {
    expect(isDue(new Date('2026-10-29T03:15:00Z'), on(1), last)).toBe(true);
  });

  it('waits out the interval', () => {
    expect(isDue(new Date('2026-11-03T03:15:00Z'), on(7), last)).toBe(false);
    expect(isDue(new Date('2026-11-04T03:15:00Z'), on(7), last)).toBe(true);
  });

  it('is due at once when there has never been one', () => {
    expect(isDue(new Date('2026-10-29T03:15:00Z'), on(7), null)).toBe(true);
  });

  it('is never due while automatic backups are off', () => {
    expect(isDue(new Date('2026-10-29T03:15:00Z'), off, null)).toBe(false);
    expect(isDue(new Date('2027-10-29T03:15:00Z'), off, last)).toBe(false);
  });
});

describe('the next automatic backup', () => {
  it('is the next 03:15 UTC once the interval has passed', () => {
    const lastAuto = new Date('2026-10-29T03:15:04Z');
    expect(nextAutoAt(new Date('2026-10-29T10:00:00Z'), on(1), lastAuto)).toEqual(new Date('2026-10-30T03:15:00Z'));
    expect(nextAutoAt(new Date('2026-10-29T10:00:00Z'), on(7), lastAuto)).toEqual(new Date('2026-11-05T03:15:00Z'));
  });

  it('is the very next 03:15 UTC when there has never been one', () => {
    expect(nextAutoAt(new Date('2026-10-29T02:00:00Z'), on(30), null)).toEqual(new Date('2026-10-29T03:15:00Z'));
    expect(nextAutoAt(new Date('2026-10-29T03:15:00Z'), on(30), null)).toEqual(new Date('2026-10-30T03:15:00Z'));
  });

  it('is the next 03:15 UTC when the last one is long overdue', () => {
    expect(nextAutoAt(new Date('2026-10-29T10:00:00Z'), on(7), new Date('2026-01-01T03:15:00Z'))).toEqual(
      new Date('2026-10-30T03:15:00Z'),
    );
  });

  it('is none while automatic backups are off', () => {
    expect(nextAutoAt(new Date('2026-10-29T10:00:00Z'), off, null)).toBeNull();
  });
});
