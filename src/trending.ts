/** 当下热门与 B 站评论区:抓热榜、按词找视频、取热门评论。解析函数单独导出,测试不联网。 */

export interface TrendItem {
  title: string;
  hot?: number;
  source: 'douyin' | 'baidu';
}

export interface BiliVideo {
  bvid: string;
  title: string;
  play: number;
  url: string;
}

export interface BiliComment {
  text: string;
  like: number;
  author: string;
  /** 主评论的 rpid,抓楼中楼时用。 */
  rpid?: string;
  /** 这条主评论下有多少条回复。 */
  rcount?: number;
}

export interface CommentThread {
  root: BiliComment;
  replies: BiliComment[];
}

export interface BiliThreadResult {
  aid: number;
  cid: number;
  threads: CommentThread[];
}

export interface NetOutcome<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const TIMEOUT_MS = 12_000;

export async function fetchTrending(
  fetchImpl: typeof fetch,
  limit: number,
): Promise<NetOutcome<TrendItem[]>> {
  const items: TrendItem[] = [];
  const errors: string[] = [];

  const douyin = await fetchJson('https://www.douyin.com/aweme/v1/web/hot/search/list/', fetchImpl, {
    referer: 'https://www.douyin.com/',
  });
  if (douyin.ok) items.push(...parseDouyinHot(douyin.value));
  else errors.push(`抖音热榜:${douyin.error}`);

  const baidu = await fetchText('https://top.baidu.com/board?tab=realtime', fetchImpl, {
    referer: 'https://top.baidu.com/',
  });
  if (baidu.ok) items.push(...parseBaiduHot(baidu.value));
  else errors.push(`百度热搜:${baidu.error}`);

  if (!items.length) {
    return { ok: false, error: errors.join(';') || '没有拿到热榜' };
  }
  const seen = new Set<string>();
  const unique = items.filter((item) => {
    if (seen.has(item.title)) return false;
    seen.add(item.title);
    return true;
  });
  unique.sort((a, b) => (b.hot ?? 0) - (a.hot ?? 0));
  return { ok: true, value: unique.slice(0, Math.max(1, limit)) };
}

export function parseDouyinHot(payload: unknown): TrendItem[] {
  const root = payload as { data?: { word_list?: unknown[] } } | null;
  const list = root?.data?.word_list;
  if (!Array.isArray(list)) return [];
  const items: TrendItem[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const title = typeof row.word === 'string' ? row.word.trim() : '';
    if (!title) continue;
    const hot = typeof row.hot_value === 'number' ? row.hot_value : undefined;
    items.push({ title, hot, source: 'douyin' });
  }
  return items;
}

export function parseBaiduHot(html: string): TrendItem[] {
  const items: TrendItem[] = [];
  const seen = new Set<string>();
  const pattern = /class="c-single-text-ellipsis"[^>]*>([\s\S]*?)<\//g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const title = decodeEntities(match[1].replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
    if (!title || title.length < 2 || seen.has(title)) continue;
    seen.add(title);
    items.push({ title, source: 'baidu' });
  }
  return items;
}

/** B 站搜索:按关键词找视频,按播放量降序。 */
export async function searchBiliVideos(
  query: string,
  fetchImpl: typeof fetch,
  limit: number,
): Promise<NetOutcome<BiliVideo[]>> {
  const url =
    'https://api.bilibili.com/x/web-interface/search/type?search_type=video&page=1&keyword=' +
    encodeURIComponent(query);
  const response = await fetchJson(url, fetchImpl, { referer: 'https://www.bilibili.com/' });
  if (!response.ok) return { ok: false, error: response.error };
  const videos = parseBiliSearch(response.value);
  if (!videos.length) return { ok: false, error: '没有搜到相关视频' };
  videos.sort((a, b) => b.play - a.play);
  return { ok: true, value: videos.slice(0, Math.max(1, limit)) };
}

export function parseBiliSearch(payload: unknown): BiliVideo[] {
  const root = payload as { data?: { result?: unknown[] } } | null;
  const list = root?.data?.result;
  if (!Array.isArray(list)) return [];
  const videos: BiliVideo[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const bvid = typeof row.bvid === 'string' ? row.bvid : '';
    if (!bvid) continue;
    const title = stripTags(typeof row.title === 'string' ? row.title : '');
    if (!title) continue;
    const play = typeof row.play === 'number' ? row.play : Number(row.play) || 0;
    videos.push({ bvid, title, play, url: `https://www.bilibili.com/video/${bvid}` });
  }
  return videos;
}

/** B 站热门评论与楼中楼:未登录时主评论只给 3 条,但每条下面的回复能读 20 条。 */
export async function fetchBiliThread(
  bvid: string,
  fetchImpl: typeof fetch,
  maxThreads: number,
  maxReplies: number,
): Promise<NetOutcome<BiliThreadResult>> {
  const view = await fetchJson(
    `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
    fetchImpl,
    { referer: 'https://www.bilibili.com/' },
  );
  if (!view.ok) return { ok: false, error: view.error };
  const aid = readAid(view.value);
  const cid = readCid(view.value);
  if (!aid) return { ok: false, error: '拿不到视频的 aid' };

  const main = await fetchJson(
    `https://api.bilibili.com/x/v2/reply?type=1&oid=${aid}&sort=2&ps=20&pn=1`,
    fetchImpl,
    { referer: 'https://www.bilibili.com/' },
  );
  if (!main.ok) return { ok: false, error: main.error };
  const roots = parseBiliReplies(main.value).slice(0, Math.max(1, maxThreads));
  if (!roots.length) return { ok: false, error: '这个视频还没有评论' };

  const threads: CommentThread[] = [];
  for (const root of roots) {
    let replies: BiliComment[] = [];
    if (root.rpid && (root.rcount ?? 0) > 0) {
      const sub = await fetchJson(
        `https://api.bilibili.com/x/v2/reply/reply?type=1&oid=${aid}&root=${root.rpid}&ps=20&pn=1`,
        fetchImpl,
        { referer: 'https://www.bilibili.com/' },
      );
      if (sub.ok) replies = parseBiliReplies(sub.value).slice(0, Math.max(1, maxReplies));
    }
    threads.push({ root, replies });
  }
  return { ok: true, value: { aid, cid, threads } };
}

/** 弹幕:短句居多,适合学「一句话怎么接」。 */
export async function fetchDanmaku(
  cid: number,
  fetchImpl: typeof fetch,
  limit: number,
): Promise<NetOutcome<string[]>> {
  if (!cid) return { ok: false, error: '没有 cid' };
  const response = await request(
    `https://comment.bilibili.com/${cid}.xml`,
    fetchImpl,
    { referer: 'https://www.bilibili.com/' },
    'text/xml,*/*',
  );
  if (!response.ok) return { ok: false, error: response.error };
  const items = parseDanmaku(response.body, limit);
  if (!items.length) return { ok: false, error: '没有弹幕' };
  return { ok: true, value: items };
}

export function parseDanmaku(xml: string, limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const pattern = /<d[^>]*>([\s\S]*?)<\/d>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null && out.length < limit) {
    const text = decodeEntities(match[1]).replace(/\s+/g, ' ').trim();
    if (!text || text.length < 2 || text.length > 40 || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function readAid(payload: unknown): number {
  const root = payload as { data?: { aid?: unknown } } | null;
  const aid = root?.data?.aid;
  return typeof aid === 'number' ? aid : 0;
}

function readCid(payload: unknown): number {
  const root = payload as { data?: { cid?: unknown } } | null;
  const cid = root?.data?.cid;
  return typeof cid === 'number' ? cid : 0;
}

export function parseBiliReplies(payload: unknown): BiliComment[] {
  const root = payload as
    | { data?: { replies?: unknown[]; top_replies?: unknown[] } }
    | null;
  const rows = [
    ...(Array.isArray(root?.data?.top_replies) ? root?.data?.top_replies : []),
    ...(Array.isArray(root?.data?.replies) ? root?.data?.replies : []),
  ];
  const comments: BiliComment[] = [];
  const seen = new Set<string>();
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const content = row.content as { message?: unknown } | undefined;
    const message = content && typeof content.message === 'string' ? content.message.trim() : '';
    if (!message || seen.has(message)) continue;
    seen.add(message);
    const member = row.member as { uname?: unknown } | undefined;
    comments.push({
      text: message.slice(0, 300),
      like: typeof row.like === 'number' ? row.like : 0,
      author: member && typeof member.uname === 'string' ? member.uname : '',
      rpid:
        typeof row.rpid_str === 'string'
          ? row.rpid_str
          : typeof row.rpid === 'number'
            ? String(row.rpid)
            : undefined,
      rcount: typeof row.rcount === 'number' ? row.rcount : 0,
    });
  }
  return comments;
}

// ---- 传输 ----

interface JsonOutcome {
  ok: boolean;
  value?: unknown;
  error?: string;
}

async function fetchJson(
  url: string,
  fetchImpl: typeof fetch,
  headers: Record<string, string>,
): Promise<JsonOutcome> {
  const response = await request(url, fetchImpl, headers, 'application/json,text/plain,*/*');
  if (!response.ok) return { ok: false, error: response.error };
  try {
    return { ok: true, value: JSON.parse(response.body) };
  } catch {
    return { ok: false, error: '响应不是合法 JSON' };
  }
}

async function fetchText(
  url: string,
  fetchImpl: typeof fetch,
  headers: Record<string, string>,
): Promise<{ ok: boolean; value: string; error?: string }> {
  const response = await request(url, fetchImpl, headers, 'text/html,*/*');
  if (!response.ok) return { ok: false, value: '', error: response.error };
  return { ok: true, value: response.body };
}

async function request(
  url: string,
  fetchImpl: typeof fetch,
  extra: Record<string, string>,
  accept: string,
): Promise<{ ok: boolean; body: string; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      headers: {
        'user-agent': UA,
        'accept-language': 'zh-CN,zh;q=0.9',
        accept,
        ...extra,
      },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!response.ok) return { ok: false, body: '', error: `HTTP ${response.status}` };
    return { ok: true, body: await response.text() };
  } catch (err) {
    const error =
      err instanceof Error
        ? err.name === 'AbortError'
          ? '请求超时'
          : `${err.message}${(err as { cause?: { code?: string } }).cause?.code ? `(${(err as { cause?: { code?: string } }).cause?.code})` : ''}`
        : String(err);
    return { ok: false, body: '', error };
  } finally {
    clearTimeout(timer);
  }
}

function stripTags(text: string): string {
  // 块级标签换成空格,行内标签直接去掉:标题里 <em> 高亮不该把词断开。
  return decodeEntities(
    text.replace(/<\/?(?:br|p|div|li|ul|ol|h[1-6])[^>]*>/gi, ' ').replace(/<[^>]*>/g, ''),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    nbsp: ' ', ensp: ' ', emsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
    middot: '·', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’',
    ldquo: '“', rdquo: '”',
  };
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return named[body.toLowerCase()] ?? whole;
  });
}
