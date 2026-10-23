/** 表情的场合判断:把「现在是什么气氛」落到一张已标注的表情包上。 */
import type { StickerTag } from './library.ts';

/** 同一情绪的不同说法归到一组;命中的任一词都算这组。 */
const MOOD_GROUPS: readonly (readonly string[])[] = [
  ['尴尬', '无语', '冷场', '尬住', '社死'],
  ['开心', '高兴', '庆祝', '恭喜', '夸赞', '得意'],
  ['安慰', '心疼', '难过', '共情', '抱抱'],
  ['嘲讽', '阴阳', '怼', '损', '吐槽'],
  ['震惊', '离谱', '懵', '没想到'],
  ['敷衍', '应付', '懒得说', '沉默'],
  ['撒娇', '粘人', '求饶', '卖萌'],
  ['赞同', '同意', '点头', '懂了'],
];

/** 把输入落到一组同义词;没有对应组时返回只含自己的单元素组。 */
export function moodGroup(mood: string): string[] {
  const key = mood.trim().toLowerCase();
  if (!key) return [];
  for (const group of MOOD_GROUPS) {
    if (group.some((word) => word.toLowerCase() === key || key.includes(word.toLowerCase()))) {
      return [...group];
    }
  }
  return [key];
}

export interface StickerMatch {
  entry: StickerTag;
  /** 命中的那一组词,给人看。 */
  via: string;
}

/** 按气氛找已标注的表情;同组同义都算命中,先返回完全同词的。 */
export function matchStickers(
  tags: readonly StickerTag[],
  mood: string,
  limit: number,
): StickerMatch[] {
  const group = moodGroup(mood);
  if (!group.length) return [];
  const exact = group[0]?.toLowerCase() ?? '';
  const scored: Array<StickerMatch & { score: number }> = [];
  for (const entry of tags) {
    const tagMood = entry.mood.trim().toLowerCase();
    const hit = group.find((word) => tagMood === word.toLowerCase() || tagMood.includes(word.toLowerCase()));
    if (!hit) continue;
    const score = tagMood === exact ? 100 : 60;
    scored.push({ entry, via: hit, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, limit)).map(({ entry, via }) => ({ entry, via }));
}

/** 从 qqbot 的 sticker-index.json 里取出文件名清单;格式不认识时返回空。 */
export function readStickerIndex(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object') return [];
  const root = raw as Record<string, unknown>;
  const items = (root.items ?? root) as Record<string, unknown>;
  const out: string[] = [];
  for (const value of Object.values(items)) {
    if (!value || typeof value !== 'object') continue;
    const record = value as Record<string, unknown>;
    const file = typeof record.file === 'string' ? record.file.trim() : '';
    if (file) out.push(file);
  }
  return out;
}
