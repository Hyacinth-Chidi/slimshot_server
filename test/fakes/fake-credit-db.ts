type Status = 'active' | 'suspended' | 'deleted';

export interface FakeUser {
  id: string;
  accountStatus: Status;
  creditBalance: number;
}

export interface FakeLedgerRow {
  id: string;
  userId: string;
  type: string;
  amount: number;
  balanceAfter: number;
  idempotencyKey: string;
  reference: string | null;
  metadata: unknown;
  createdAt: Date;
}

// Every call yields first, so concurrent callers interleave the way real
// requests do: an implementation that reads a balance and writes it back
// later overdraws here, exactly as it would in Postgres.
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function uniqueViolation(): Error {
  return Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
}

/** The slice of Prisma the ledger uses, in memory, with per-transaction rollback. */
export class FakeCreditDb {
  users = new Map<string, FakeUser>();
  ledger: FakeLedgerRow[] = [];
  transactionCalls = 0;
  private seq = 0;

  addUser(id: string, creditBalance = 0, accountStatus: Status = 'active'): void {
    this.users.set(id, { id, accountStatus, creditBalance });
  }

  ledgerSum(userId: string): number {
    return this.ledger.filter((r) => r.userId === userId).reduce((sum, r) => sum + r.amount, 0);
  }

  client(undo?: Array<() => void>) {
    const db = this;
    return {
      user: {
        async updateMany(args: {
          where: { id: string; accountStatus: Status | { not: Status }; creditBalance?: { gte: number } };
          data: { creditBalance: { increment: number } };
        }) {
          await tick();
          const u = db.users.get(args.where.id);
          const status = args.where.accountStatus;
          const statusOk =
            !!u && (typeof status === 'string' ? u.accountStatus === status : u.accountStatus !== status.not);
          if (!u || !statusOk || (args.where.creditBalance && u.creditBalance < args.where.creditBalance.gte)) {
            return { count: 0 };
          }
          const inc = args.data.creditBalance.increment;
          u.creditBalance += inc;
          undo?.push(() => {
            u.creditBalance -= inc;
          });
          return { count: 1 };
        },
        async findUnique(args: { where: { id: string } }) {
          await tick();
          const u = db.users.get(args.where.id);
          return u ? { ...u } : null;
        },
        async findUniqueOrThrow(args: { where: { id: string } }) {
          await tick();
          const u = db.users.get(args.where.id);
          if (!u) throw Object.assign(new Error('No record'), { code: 'P2025' });
          return { ...u };
        },
      },
      creditTransaction: {
        async create(args: {
          data: Omit<FakeLedgerRow, 'id' | 'createdAt' | 'reference' | 'metadata'> & {
            reference?: string;
            metadata?: unknown;
          };
        }) {
          await tick();
          if (db.ledger.some((r) => r.idempotencyKey === args.data.idempotencyKey)) throw uniqueViolation();
          const row: FakeLedgerRow = {
            id: `tx-${(db.seq += 1)}`,
            reference: args.data.reference ?? null,
            metadata: args.data.metadata ?? null,
            createdAt: new Date(),
            ...args.data,
          };
          db.ledger.push(row);
          undo?.push(() => {
            db.ledger.splice(db.ledger.indexOf(row), 1);
          });
          return { ...row };
        },
        async findUnique(args: { where: { idempotencyKey: string } }) {
          await tick();
          const row = db.ledger.find((r) => r.idempotencyKey === args.where.idempotencyKey);
          return row ? { ...row } : null;
        },
        async count(args: { where: { userId: string; type?: string; createdAt?: { gte: Date } } }) {
          await tick();
          return db.ledger.filter(
            (r) =>
              r.userId === args.where.userId &&
              (args.where.type === undefined || r.type === args.where.type) &&
              (args.where.createdAt === undefined || r.createdAt >= args.where.createdAt.gte),
          ).length;
        },
      },
      async $queryRaw(): Promise<unknown[]> {
        await tick();
        return [];
      },
    };
  }

  /** Hand this to services as their PrismaService. */
  prisma() {
    return {
      ...this.client(),
      $transaction: async <T>(fn: (tx: ReturnType<FakeCreditDb['client']>) => Promise<T>): Promise<T> => {
        this.transactionCalls += 1;
        const undo: Array<() => void> = [];
        try {
          return await fn(this.client(undo));
        } catch (err) {
          for (const step of undo.reverse()) step();
          throw err;
        }
      },
    };
  }
}
