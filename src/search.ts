/** 联网查词与抓图。解析函数单独导出,测试不联网。 */

export interface SearchHit {
  title: string;
  snippet: string;
  url: string;
}

export interface SearchResult {
  ok: boolean;
  hits: SearchHit[];
  /** 实际请求的地址,回执里给模型看来源。 */
  source: string;
  error?: string;
}

export interface SearchOptions {
  query: string;
  /** 空串表示用内置的 DuckDuckGo HTML 页。 */
  endpoint: string;
  /** `searchApiKeyName` 指向的密钥值;空串不加认证头。 */
  apiKey: string;
  maxResults: number;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
}

const BUILTIN_SOURCES = [
  {
    /** 中文新词与梗的命中率最好,带摘要。 */
    url: (query: string) => `https://www.so.com/s?q=${encodeURIComponent(query)}`,
    parse: (html: string, max: number) => parseSo360Html(html, max),
  },
  {
    /** 标题最像聊天里的说法;链接是站内跳转。 */
    url: (query: string) => `https://www.sogou.com/web?query=${encodeURIComponent(query)}`,
    parse: (html: string, max: number) => parseSogouHtml(html, max),
  },
  {
    /** 出境网络下可用;RSS 比 HTML 页稳定。 */
    url: (query: string) => `https://www.bing.com/search?format=rss&q=${encodeURIComponent(query)}&count=10`,
    parse: (body: string, max: number) => parseBingRss(body, max),
  },
  {
    url: (query: string) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=cn-zh`,
    parse: (html: string, max: number) => parseDuckDuckGoHtml(html, max),
  },
];
const TIMEOUT_MS = 12_000;

export async function searchWeb(opts: SearchOptions): Promise<SearchResult> {
  const endpoint = opts.endpoint.trim();
  if (endpoint) {
    const url = withQuery(endpoint, opts.query);
    const page = await fetchPage(url, opts);
    if (!page.ok) return { ok: false, hits: [], source: url, error: page.error };
    const hits = page.json
      ? parseJsonHits(page.json, opts.maxResults)
      : parseGenericHtml(page.body, opts.maxResults);
    return { ok: true, hits, source: url };
  }

  let lastError = '';
  const tried: string[] = [];
  for (const source of BUILTIN_SOURCES) {
    const url = source.url(opts.query);
    tried.push(url);
    const page = await fetchPage(url, opts);
    if (!page.ok) {
      lastError = page.error;
      continue;
    }
    const hits = source.parse(page.body, opts.maxResults);
    if (hits.length) return { ok: true, hits, source: url };
    lastError = '没有可解析的结果';
  }
  return {
    ok: false,
    hits: [],
    source: tried.join(' | '),
    error: lastError ? `${lastError}(内置源都试过)` : '没有可用的搜索源',
  };
}

interface FetchedPage {
  ok: true;
  body: string;
  json?: unknown;
}

async function fetchPage(
  url: string,
  opts: SearchOptions,
): Promise<FetchedPage | { ok: false; error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, controller.signal])
    : controller.signal;
  const headers: Record<string, string> = {
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
  };
  if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;
  try {
    const response = await opts.fetchImpl(url, { headers, signal, redirect: 'follow' });
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` };
    }
    const body = await response.text();
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('json') || /^\s*[[{]/.test(body)) {
      try {
        return { ok: true, body, json: JSON.parse(body) };
      } catch {
        return { ok: false, error: '响应不是合法 JSON' };
      }
    }
    return { ok: true, body };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  } finally {
    clearTimeout(timer);
  }
}

function withQuery(endpoint: string, query: string): string {
  const sep = endpoint.includes('?') ? '&' : '?';
  return `${endpoint}${sep}q=${encodeURIComponent(query)}`;
}

/** 360 的结果块:`h3.res-title > a` 与 `p.res-desc`。 */
export function parseSo360Html(html: string, maxResults: number): SearchHit[] {
  const hits: SearchHit[] = [];
  const heading = /<h3[^>]*>([\s\S]*?)<\/h3>/gi;
  let match: RegExpExecArray | null;
  while ((match = heading.exec(html)) !== null && hits.length < maxResults) {
    const href = /href="([^"]+)"/i.exec(match[1])?.[1] ?? '';
    const title = normalizeText(stripTags(match[1]));
    if (!href || !title || title.length < 4) continue;
    if (title === '其他人还搜了' || title === '相关搜索') continue;
    hits.push({ title, snippet: '', url: decodeEntities(href) });
  }
  const desc = /<p[^>]*class="[^"]*res-desc[^"]*"[^>]*>([\s\S]*?)<\/p>/gi;
  let index = 0;
  let snippet: RegExpExecArray | null;
  while ((snippet = desc.exec(html)) !== null && index < hits.length) {
    hits[index].snippet = normalizeText(stripTags(snippet[1]));
    index += 1;
  }
  return hits;
}

/** 搜狗的结果块:`h3 > a`,链接是 `/link?url=` 跳转,拼成绝对地址。 */
export function parseSogouHtml(html: string, maxResults: number): SearchHit[] {
  const hits: SearchHit[] = [];
  const heading = /<h3[^>]*>([\s\S]*?)<\/h3>/gi;
  let match: RegExpExecArray | null;
  while ((match = heading.exec(html)) !== null && hits.length < maxResults) {
    const href = /href="([^"]+)"/i.exec(match[1])?.[1] ?? '';
    const title = normalizeText(stripTags(match[1]));
    if (!href || !title || title.length < 4) continue;
    let url = decodeEntities(href);
    if (url.startsWith('/')) url = `https://www.sogou.com${url}`;
    hits.push({ title, snippet: '', url });
  }
  const desc = /<div[^>]*class="[^"]*(?:text-layout|fz-mid|str-text-info)[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
  let index = 0;
  let snippet: RegExpExecArray | null;
  while ((snippet = desc.exec(html)) !== null && index < hits.length) {
    const text = normalizeText(stripTags(snippet[1]));
    if (text) {
      hits[index].snippet = text;
      index += 1;
    }
  }
  return hits;
}

/** Bing 的 RSS 输出:`<item>` 里是 title / link / description。 */
export function parseBingRss(xml: string, maxResults: number): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const item of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    if (hits.length >= maxResults) break;
    const body = item[1];
    const title = tagText(body, 'title');
    const url = tagText(body, 'link');
    const snippet = tagText(body, 'description');
    if (!title || !url) continue;
    hits.push({ title, snippet, url });
  }
  return hits;
}

function tagText(xml: string, tag: string): string {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
  if (!match) return '';
  return normalizeText(match[1].replace(/<!\[CDATA\[|\]\]>/g, ''));
}

/** Bing 的结果块是 `<li class="b_algo">`,标题在 `h2 > a`,摘要在第一个 `<p>`。 */
export function parseBingHtml(html: string, maxResults: number): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const part of html.split('<li class="b_algo"').slice(1)) {
    if (hits.length >= maxResults) break;
    const anchor = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(part);
    if (!anchor) continue;
    const url = decodeEntities(anchor[1]);
    const title = normalizeText(stripTags(anchor[2]));
    if (!url || !title) continue;
    const paragraph = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(part);
    const snippet = paragraph
      ? normalizeText(stripTags(paragraph[1])).replace(/\s*阅读更.*$/, '').trim()
      : '';
    hits.push({ title, snippet, url });
  }
  return hits;
}

/** 从一页搜索结果里取标题、摘要、地址。测试用固定 HTML。 */
export function parseDuckDuckGoHtml(html: string, maxResults: number): SearchHit[] {
  const hits: SearchHit[] = [];
  const anchor = /<a\b[^>]*class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  const hrefAt = /href="([^"]+)"/i;
  let match: RegExpExecArray | null;
  while ((match = anchor.exec(html)) !== null && hits.length < maxResults) {
    const tag = match[0];
    const href = hrefAt.exec(tag)?.[1] ?? '';
    const title = normalizeText(stripTags(match[1]));
    if (!href || !title) continue;
    hits.push({ title, snippet: '', url: unwrapDuckDuckGo(href) });
  }
  // 摘要按结果块配对;取不到时留空,不编造。
  const snippetRe = /<a\b[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let index = 0;
  let snippet: RegExpExecArray | null;
  while ((snippet = snippetRe.exec(html)) !== null && index < hits.length) {
    hits[index].snippet = normalizeText(stripTags(snippet[1]));
    index += 1;
  }
  return hits;
}

/** 通用 HTML 兜底:没有约定结构时,取有 href 的链接与其文字。 */
export function parseGenericHtml(html: string, maxResults: number): SearchHit[] {
  const hits: SearchHit[] = [];
  const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchor.exec(html)) !== null && hits.length < maxResults) {
    const href = /href="([^"]+)"/i.exec(match[1])?.[1] ?? '';
    const title = normalizeText(stripTags(match[2]));
    if (!href || !/^https?:/i.test(href) || title.length < 2) continue;
    hits.push({ title, snippet: '', url: href });
  }
  return hits;
}

/** 认常见的 JSON 搜索响应形状;认不出时返回空数组。 */
export function parseJsonHits(payload: unknown, maxResults: number): SearchHit[] {
  const list = findResultArray(payload);
  const hits: SearchHit[] = [];
  for (const item of list) {
    if (hits.length >= maxResults) break;
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const url = firstString(row, ['url', 'link', 'href', 'displayLink']);
    const title = firstString(row, ['title', 'name', 'heading']);
    const snippet = firstString(row, ['snippet', 'description', 'content', 'body', 'text']);
    if (!url || !title) continue;
    hits.push({ title, snippet, url });
  }
  return hits;
}

function findResultArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  const root = payload as Record<string, unknown>;
  for (const key of ['results', 'organic', 'organic_results', 'items', 'data', 'hits']) {
    const value = root[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') {
      const nested = findResultArray(value);
      if (nested.length) return nested;
    }
  }
  return [];
}

function firstString(row: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/** 取页面里的 og:image / twitter:image,相对地址按页面 URL 补全。 */
export function findPageImage(html: string, pageUrl: string): string | null {
  const patterns = [
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
    /<img[^>]+src=["']([^"']+\.(?:png|jpe?g|gif|webp))["']/i,
  ];
  for (const pattern of patterns) {
    const found = pattern.exec(html)?.[1];
    if (!found) continue;
    try {
      return new URL(found, pageUrl).toString();
    } catch {
      continue;
    }
  }
  return null;
}

export interface DownloadedImage {
  bytes: Uint8Array;
  mime: string;
}

/** 下载一张图;只接受图片响应,超过上限时拒绝。 */
export async function downloadImage(
  url: string,
  fetchImpl: typeof fetch,
  maxBytes = 8 * 1024 * 1024,
): Promise<{ ok: true; image: DownloadedImage } | { ok: false; error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; CorticoNetlingo/0.1)' },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    const mime = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!mime.startsWith('image/')) return { ok: false, error: `不是图片(${mime || '未知类型'})` };
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength === 0) return { ok: false, error: '空响应' };
    if (buffer.byteLength > maxBytes) return { ok: false, error: `超过 ${maxBytes} 字节上限` };
    return { ok: true, image: { bytes: buffer, mime } };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  } finally {
    clearTimeout(timer);
  }
}

export function extensionForMime(mime: string): string {
  switch (mime) {
    case 'image/png':
      return '.png';
    case 'image/jpeg':
      return '.jpg';
    case 'image/gif':
      return '.gif';
    case 'image/webp':
      return '.webp';
    case 'image/avif':
      return '.avif';
    default:
      return '.img';
  }
}

export function describeError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'AbortError') return '请求超时';
    const cause = (err as { cause?: { code?: string } }).cause;
    return cause?.code ? `${err.message}(${cause.code})` : err.message;
  }
  return String(err);
}

function stripTags(text: string): string {
  // 块级标签换成空格,行内标签直接去掉:标题里的 <strong> 高亮不该把词断开。
  return text
    .replace(/<\/?(?:br|p|div|li|ul|ol|h[1-6]|tr|td|section|article)[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, '');
}

function normalizeText(text: string): string {
  return decodeEntities(text).replace(/\s+/g, ' ').trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"',
  apos: "'", middot: '·', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', copy: '©', reg: '®', times: '×', laquo: '«', raquo: '»',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      return safeCodePoint(Number.parseInt(body.slice(2), 16)) ?? whole;
    }
    if (body.startsWith('#')) {
      return safeCodePoint(Number.parseInt(body.slice(1), 10)) ?? whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function safeCodePoint(code: number): string | null {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return null;
  try {
    return String.fromCodePoint(code);
  } catch {
    return null;
  }
}

/** DuckDuckGo 的跳转链接里真正的地址在 uddg 参数上。 */
function unwrapDuckDuckGo(href: string): string {
  try {
    const url = new URL(href, 'https://duckduckgo.com');
    const target = url.searchParams.get('uddg');
    return target ? decodeURIComponent(target) : url.toString();
  } catch {
    return href;
  }
}
