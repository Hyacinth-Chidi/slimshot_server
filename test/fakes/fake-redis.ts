/** The few ioredis calls this codebase uses, in memory, with a settable clock. */
export class FakeRedis {
  now = (): number => Date.now();
  private store = new Map<string, { value: string; expiresAt: number | null }>();

  private live(key: string) {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= this.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry;
  }

  async get(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null;
  }

  async set(key: string, value: string | number, ...args: Array<string | number>): Promise<'OK' | null> {
    let ttl: number | null = null;
    let nx = false;
    for (let i = 0; i < args.length; i += 1) {
      const flag = String(args[i]).toUpperCase();
      if (flag === 'EX') ttl = Number(args[(i += 1)]);
      else if (flag === 'NX') nx = true;
    }
    if (nx && this.live(key)) return null;
    this.store.set(key, { value: String(value), expiresAt: ttl === null ? null : this.now() + ttl * 1000 });
    return 'OK';
  }

  async incr(key: string): Promise<number> {
    const entry = this.live(key);
    const next = Number(entry?.value ?? '0') + 1;
    this.store.set(key, { value: String(next), expiresAt: entry?.expiresAt ?? null });
    return next;
  }

  async ttl(key: string): Promise<number> {
    const entry = this.live(key);
    if (!entry) return -2;
    if (entry.expiresAt === null) return -1;
    return Math.ceil((entry.expiresAt - this.now()) / 1000);
  }

  async del(...keys: string[]): Promise<number> {
    return keys.filter((k) => this.store.delete(k)).length;
  }

  values(): string[] {
    return [...this.store.values()].map((e) => e.value);
  }
}
