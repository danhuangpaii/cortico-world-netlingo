/** 每日额度:联网查找次数与主动提醒次数,按本地日期滚日,落 `<dataDir>/netlingo-quota.json`。 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface QuotaState {
  /** YYYY-MM-DD,本地日期。 */
  day: string;
  searches: number;
  opportunities: number;
}

export const QUOTA_FILE = 'netlingo-quota.json';

/** 本地日期;`en-CA` 的格式正好是 YYYY-MM-DD。 */
export function localDay(now: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export class Quota {
  private state: QuotaState;

  constructor(
    private readonly dataDir: string,
    private readonly timezone: string,
    private readonly now: () => number = Date.now,
  ) {
    this.state = { day: this.today(), searches: 0, opportunities: 0 };
    this.load();
    this.roll();
  }

  today(): string {
    return localDay(new Date(this.now()), this.timezone);
  }

  get searches(): number {
    this.roll();
    return this.state.searches;
  }

  get opportunities(): number {
    this.roll();
    return this.state.opportunities;
  }

  /** 0 表示不限。 */
  searchLimit(limit: number): number {
    return limit > 0 ? limit : Number.POSITIVE_INFINITY;
  }

  /** 消耗一次联网查找额度;`limit` 为 0 时不限。 */
  consumeSearch(limit: number): { ok: true; used: number } | { ok: false; used: number; limit: number } {
    this.roll();
    const cap = this.searchLimit(limit);
    if (this.state.searches >= cap) {
      return { ok: false, used: this.state.searches, limit };
    }
    this.state.searches += 1;
    this.save();
    return { ok: true, used: this.state.searches };
  }

  /** 今日主动提醒是否还有额度;`limit` 为 0 时不限。 */
  canOffer(limit: number): boolean {
    this.roll();
    if (limit <= 0) return true;
    return this.state.opportunities < limit;
  }

  bumpOpportunity(): number {
    this.roll();
    this.state.opportunities += 1;
    this.save();
    return this.state.opportunities;
  }

  resetText(): string {
    return '明天 0 点(本地时间)重置';
  }

  private path(): string {
    return join(this.dataDir, QUOTA_FILE);
  }

  private roll(): void {
    const today = this.today();
    if (this.state.day !== today) {
      this.state = { day: today, searches: 0, opportunities: 0 };
      this.save();
    }
  }

  private load(): void {
    const file = this.path();
    if (!existsSync(file)) return;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<QuotaState>;
      if (typeof raw.day === 'string') {
        this.state = {
          day: raw.day,
          searches: typeof raw.searches === 'number' ? raw.searches : 0,
          opportunities: typeof raw.opportunities === 'number' ? raw.opportunities : 0,
        };
      }
    } catch {
      // 读不动就从零开始,下一次写入会覆盖。
    }
  }

  private save(): void {
    try {
      mkdirSync(this.dataDir, { recursive: true });
      const tmp = `${this.path()}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8');
      renameSync(tmp, this.path());
    } catch {
      // 额度是尽力而为的计数,写盘失败不打断工具调用。
    }
  }
}
