/** 本地素材库:词条与梗图,落 `<dataDir>/netlingo-library.json`,图片落 `netlingo-memes/`。 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface TermEntry {
  term: string;
  meaning: string;
  example?: string;
  sourceUrl?: string;
  tags?: string[];
  /** 常见接龙:别人抛这个梗时，接哪句是真的。 */
  chains?: string[];
  /** 同一个梗的其他写法,查找时也算命中。 */
  aliases?: string[];
  learnedAt: string;
}

export interface MemeEntry {
  /** 相对 `netlingo-memes/` 的文件名。 */
  file: string;
  name: string;
  mime: string;
  sourceUrl?: string;
  caption?: string;
  addedAt: string;
}

/** 一来一回的对话对:群聊里捕捉到的,或从 B 站楼中楼存下来的。 */
export interface ExchangeEntry {
  /** 挑起的那一句。 */
  a: string;
  /** 接住的那一句。 */
  b: string;
  /** 从哪来:qq群 / B站 / 其他。 */
  where: string;
  topic?: string;
  note?: string;
  savedAt: string;
}

/** 给一张表情包记的用法:什么场合、什么情绪时发它。 */
export interface StickerTag {
  /** 表情包文件名,如 sticker-xxxx.gif。 */
  file: string;
  /** 情绪或场合关键词,如「尴尬」「庆祝」。 */
  mood: string;
  /** 一句话说明什么时候用。 */
  when?: string;
  note?: string;
  savedAt: string;
}

export interface LibraryFile {
  terms: TermEntry[];
  memes: MemeEntry[];
  exchanges: ExchangeEntry[];
  stickers: StickerTag[];
}

export const LIBRARY_FILE = 'netlingo-library.json';
export const MEME_DIR = 'netlingo-memes';

const EMPTY: LibraryFile = { terms: [], memes: [], exchanges: [], stickers: [] };

export class Library {
  constructor(private readonly dataDir: string) {}

  path(): string {
    return join(this.dataDir, LIBRARY_FILE);
  }

  memeDir(): string {
    return join(this.dataDir, MEME_DIR);
  }

  load(): LibraryFile {
    const file = this.path();
    if (!existsSync(file)) return { terms: [], memes: [], exchanges: [], stickers: [] };
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<LibraryFile>;
      return {
        terms: Array.isArray(raw.terms) ? raw.terms.filter(isTerm) : [],
        memes: Array.isArray(raw.memes) ? raw.memes.filter(isMeme) : [],
        // 旧文件没有这一段,补空数组。
        exchanges: Array.isArray(raw.exchanges) ? raw.exchanges.filter(isExchange) : [],
        stickers: Array.isArray(raw.stickers) ? raw.stickers.filter(isStickerTag) : [],
      };
    } catch {
      return { terms: [], memes: [], exchanges: [], stickers: [] };
    }
  }

  save(lib: LibraryFile): void {
    mkdirSync(this.dataDir, { recursive: true });
    const tmp = `${this.path()}.tmp`;
    writeFileSync(tmp, JSON.stringify(lib, null, 2), 'utf8');
    renameSync(tmp, this.path());
  }

  /** 同名词条后写的覆盖前面的;大小写与首尾空白不计。 */
  addTerm(lib: LibraryFile, entry: TermEntry): { replaced: boolean } {
    const key = entry.term.trim().toLowerCase();
    const at = lib.terms.findIndex((t) => t.term.trim().toLowerCase() === key);
    if (at >= 0) {
      lib.terms[at] = entry;
      return { replaced: true };
    }
    lib.terms.push(entry);
    return { replaced: false };
  }

  addMeme(lib: LibraryFile, entry: MemeEntry): void {
    const at = lib.memes.findIndex((m) => m.file === entry.file);
    if (at >= 0) lib.memes[at] = entry;
    else lib.memes.push(entry);
  }

  /** 同一组 a + b 只留一条;空白与大小写不计。 */
  addExchange(lib: LibraryFile, entry: ExchangeEntry): { replaced: boolean } {
    const key = exchangeKey(entry);
    const at = lib.exchanges.findIndex((item) => exchangeKey(item) === key);
    if (at >= 0) {
      lib.exchanges[at] = entry;
      return { replaced: true };
    }
    lib.exchanges.push(entry);
    return { replaced: false };
  }

  /** 同一张图 + 同一个情绪只留一条;后写的覆盖。 */
  addStickerTag(lib: LibraryFile, entry: StickerTag): { replaced: boolean } {
    const key = `${entry.file.trim().toLowerCase()}\u0000${entry.mood.trim().toLowerCase()}`;
    const at = lib.stickers.findIndex(
      (item) =>
        `${item.file.trim().toLowerCase()}\u0000${item.mood.trim().toLowerCase()}` === key,
    );
    if (at >= 0) {
      lib.stickers[at] = entry;
      return { replaced: true };
    }
    lib.stickers.push(entry);
    return { replaced: false };
  }

  ensureMemeDir(): string {
    const dir = this.memeDir();
    mkdirSync(dir, { recursive: true });
    return dir;
  }
}

export function emptyLibrary(): LibraryFile {
  return {
    terms: [...EMPTY.terms],
    memes: [...EMPTY.memes],
    exchanges: [...EMPTY.exchanges],
    stickers: [...EMPTY.stickers],
  };
}

function isTerm(v: unknown): v is TermEntry {
  const t = v as Partial<TermEntry> | null;
  return !!t && typeof t.term === 'string' && typeof t.meaning === 'string' && typeof t.learnedAt === 'string';
}

function isMeme(v: unknown): v is MemeEntry {
  const m = v as Partial<MemeEntry> | null;
  return !!m && typeof m.file === 'string' && typeof m.mime === 'string' && typeof m.addedAt === 'string';
}

function isExchange(v: unknown): v is ExchangeEntry {
  const e = v as Partial<ExchangeEntry> | null;
  return !!e && typeof e.a === 'string' && typeof e.b === 'string' && typeof e.savedAt === 'string';
}

function isStickerTag(v: unknown): v is StickerTag {
  const s = v as Partial<StickerTag> | null;
  return !!s && typeof s.file === 'string' && typeof s.mood === 'string' && typeof s.savedAt === 'string';
}

function exchangeKey(entry: ExchangeEntry): string {
  return `${entry.a.trim().toLowerCase()}\u0000${entry.b.trim().toLowerCase()}`;
}

/** 对话对检索:a、b、来源与话题都算命中;空查询返回空数组。 */
export function searchExchanges(lib: LibraryFile, query: string, limit: number): ExchangeEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits = lib.exchanges.filter(
    (item) =>
      item.a.toLowerCase().includes(q) ||
      item.b.toLowerCase().includes(q) ||
      item.where.toLowerCase().includes(q) ||
      (item.topic ?? '').toLowerCase().includes(q),
  );
  return hits.slice(-Math.max(1, limit)).reverse();
}

export interface ExchangeMatch {
  entry: ExchangeEntry;
  score: number;
  /** exact 是原话包含,partial 是近似。 */
  kind: 'exact' | 'partial';
}

/** 拿一句群聊原话去找有没有对得上的对话对;a 对上了,下一句就是 b。 */
export function matchExchanges(lib: LibraryFile, text: string, limit: number): ExchangeMatch[] {
  const normalized = normalizeText(text);
  if (!normalized) return [];
  const matches: ExchangeMatch[] = [];
  for (const entry of lib.exchanges) {
    const left = normalizeText(entry.a);
    if (!left) continue;
    const exact = normalized.includes(left);
    const score = exact ? 1 : similarity(normalized, left);
    if (score >= 0.5) matches.push({ entry, score, kind: exact ? 'exact' : 'partial' });
  }
  matches.sort((a, b) => b.score - a.score);
  return matches.slice(0, Math.max(1, limit));
}

/** 拿一句群聊原话去找它用了哪个记过的词条。 */
export function matchTerms(lib: LibraryFile, text: string, limit: number): TermEntry[] {
  const normalized = normalizeText(text);
  if (!normalized) return [];
  const hits: TermEntry[] = [];
  for (const entry of lib.terms) {
    const term = normalizeText(entry.term);
    if (!term) continue;
    if (normalized.includes(term) || similarity(normalized, term) >= 0.6) hits.push(entry);
  }
  return hits.slice(0, Math.max(1, limit));
}

/** 去掉空白、标点与符号,只留字本身;大小写不计。 */
function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

/** 字符二元组的 Jaccard 相似度;两边都空时按相等处理。 */
function similarity(left: string, right: string): number {
  if (left === right) return 1;
  const a = bigrams(left);
  const b = bigrams(right);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

function bigrams(value: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < value.length - 1; i += 1) out.add(value.slice(i, i + 2));
  return out;
}

/** 词条检索:词、含义、例句、标签都算命中;空查询返回空数组。 */
export function searchTerms(lib: LibraryFile, query: string, limit: number): TermEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored: Array<{ t: TermEntry; score: number }> = [];
  for (const t of lib.terms) {
    const term = t.term.toLowerCase();
    const meaning = t.meaning.toLowerCase();
    let score = 0;
    if (term === q) score = 100;
    else if (term.includes(q)) score = 80;
    else if (meaning.includes(q)) score = 40;
    else if (t.example?.toLowerCase().includes(q)) score = 20;
    else if (t.tags?.some((tag) => tag.toLowerCase() === q)) score = 30;
    if (score > 0) scored.push({ t, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, limit)).map((x) => x.t);
}
