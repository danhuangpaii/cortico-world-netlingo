/** 网络用语与梗:联网查、本地记、在静默满一段时间后提醒 bot 可以用。 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Language } from 'cortico/core/language.ts';
import type {
  StoragePart,
  ToolDef,
  ToolOutcome,
  World,
  WorldHost,
  WorldLamp,
  WorldWebUiDecl,
} from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import type { DeepPartial } from 'cortico/world.ts';
import {
  NETLINGO_CAPABILITY_GROUP,
  NETLINGO_PROACTIVE_GROUP,
  NETLINGO_SEARCH_GROUP,
  NETLINGO_VISION_GROUP,
  type NetlingoConfigSection,
} from './config.ts';
import {
  Library,
  matchExchanges,
  matchTerms,
  searchExchanges,
  searchTerms,
  type ExchangeEntry,
  type LibraryFile,
  type MemeEntry,
  type TermEntry,
} from './library.ts';
import { Quota, localDay } from './quota.ts';
import { describeImage, type VisionSettings } from './vision.ts';
import {
  describeError,
  downloadImage,
  extensionForMime,
  findPageImage,
  searchWeb,
  type SearchHit,
  type SearchOptions,
  type SearchResult,
} from './search.ts';
import {
  fetchBiliThread,
  fetchDanmaku,
  fetchTrending,
  searchBiliVideos,
  type BiliThreadResult,
  type BiliVideo,
  type CommentThread,
} from './trending.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));
const TICK_MS = 60_000;
const MAX_PAGE_CANDIDATES = 5;

export interface NetlingoWorldOptions {
  /** `worlds.netlingo` 的活引用。 */
  cfg: NetlingoConfigSection;
  timezone: string;
  dataDir: string;
  botName: string;
  secret: (name: string) => string;
  persist: (patch: DeepPartial<NetlingoConfigSection>) => void;
  /** 测试注入;缺省用全局 fetch。 */
  fetchImpl?: typeof fetch;
  /** 测试注入;缺省用 Date.now。 */
  now?: () => number;
}

/** 全部工具的声明;定义里的 describe 与 `tools()` 都取它。 */
export const NETLINGO_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'netlingo_search',
    description:
      '联网查一个网络用语在群聊里怎么用,返回标题、摘要与来源地址,并扣一次今日额度。查询里带上用法(如「xx 怎么接话」「xx 什么梗 例句」)更容易找到水群素材;百科、榜单与新闻只能当背景,照搬会显得像在念稿。',
    tags: ['read'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '要查的词,连同你想知道的用法,例如「「尊嘟假嘟」 怎么接话」。' },
        maxResults: { type: 'integer', description: '最多返回几条,1 到 10,默认 5。' },
      },
      required: ['query'],
    },
  },
  {
    name: 'netlingo_learn',
    description:
      '把一条网络用语记进本地库:词、它在群聊里怎么用,可带一句能直接发的例句、来源地址与标签。同名词条会被覆盖。',
    tags: ['write'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        term: { type: 'string', description: '词或梗本身。' },
        meaning: { type: 'string', description: '它在群聊里怎么用、接什么话、配什么语气;不要写词典释义。' },
        example: { type: 'string', description: '可选,一句能直接发到群里的用法。' },
        sourceUrl: { type: 'string', description: '可选,出处地址。' },
        tags: { type: 'array', items: { type: 'string' }, description: '可选,几个标签,如「嘲讽」「夸赞」。' },
      },
      required: ['term', 'meaning'],
    },
  },
  {
    name: 'netlingo_recall',
    description: '从本地库找词条:给 query 按词、含义、例句与标签匹配;不给就随机取。',
    tags: ['read'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '可选,关键词。' },
        limit: { type: 'integer', description: '最多几条,1 到 20,默认 5。' },
      },
      required: [],
    },
  },
  {
    name: 'netlingo_collect_meme',
    description:
      '收集梗图:给 urls 直接下载;给 query 则先搜索,再从结果页的 og:image 抓图。query 按场景写(如「无语 表情包」)比按词写更容易收到能用的图。图片存进本机梗图目录,并扣一次今日额度。',
    tags: ['write'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        urls: { type: 'array', items: { type: 'string' }, description: '可选,图片地址列表。' },
        query: { type: 'string', description: '可选,按场景找图,如「无语 表情包」;与 urls 二选一。' },
        caption: { type: 'string', description: '可选,给这批图记一句话。' },
        max: { type: 'integer', description: '最多几张,1 到 5,默认 3。' },
      },
      required: [],
    },
  },
  {
    name: 'netlingo_trending',
    description:
      '看当下热门话题:抖音热榜与百度热搜的标题和热度,扣一次今日额度。挑一个感兴趣的,再用 netlingo_comments 去评论区看大家怎么说话。',
    tags: ['read'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'integer', description: '最多几条,1 到 30,默认 15。' },
      },
      required: [],
    },
  },
  {
    name: 'netlingo_comments',
    description:
      '看一个话题的评论区:按关键词在 B 站找播放最高的相关视频,取热门评论的「楼 + 楼中楼回复」,再附一段弹幕短句。用来学网友怎么一来一回地拌嘴、怎么接话,扣一次今日额度。',
    tags: ['read'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        topic: { type: 'string', description: '热词或话题,通常来自 netlingo_trending。' },
        limit: { type: 'integer', description: '最多看几个楼,1 到 10,默认 3;每楼最多 20 条回复。' },
        video: { type: 'string', description: '可选,直接给 B 站视频的 BV 号,跳过搜索。' },
        save: { type: 'boolean', description: '可选,把楼中楼也存进长期库(主楼一句话配一条回复),默认不存。' },
      },
      required: ['topic'],
    },
  },
  {
    name: 'netlingo_capture',
    description:
      '把群里看到的一来一回记进长期库:一句挑起的话,加一句接住的话。以后可以用 netlingo_exchanges 翻出来,主动说话时用。',
    tags: ['write'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        a: { type: 'string', description: '挑起的那一句,原话。' },
        b: { type: 'string', description: '接住的那一句,原话。' },
        where: { type: 'string', description: '从哪来,默认 qq群。' },
        topic: { type: 'string', description: '可选,聊的是什么话题。' },
        note: { type: 'string', description: '可选,一句备注,比如「这里用了反问」。' },
      },
      required: ['a', 'b'],
    },
  },
  {
    name: 'netlingo_exchanges',
    description: '翻长期库里的对话对:给 query 按原话、来源或话题匹配;不给就随机取几组。',
    tags: ['read'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '可选,关键词。' },
        limit: { type: 'integer', description: '最多几组,1 到 20,默认 5。' },
      },
      required: [],
    },
  },
  {
    name: 'netlingo_match',
    description:
      '拿一句群聊原话查本地库:命中对话对就给出可以接的下一句,命中词条就说明这个词你记过、可以顺着再用。本地查询,不联网也不扣额度。',
    tags: ['read'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: '群友说的那句话,原样发进来。' },
        limit: { type: 'integer', description: '最多给几条结果,1 到 10,默认 5。' },
      },
      required: ['text'],
    },
  },
  {
    name: 'netlingo_describe_meme',
    description:
      '看自己库里的梗图:调用配置好的视觉模型,给每张图生成一句话描述并存进库。以后发图或挑素材时能知道图里是什么。不走每日搜索额度。',
    tags: ['read'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        file: { type: 'string', description: '可选,只描述这一张(文件名)。不给就挑还没描述过的。' },
        limit: { type: 'integer', description: '最多描述几张,1 到 10,默认 3。' },
      },
      required: [],
    },
  },
  {
    name: 'netlingo_pick',
    description: '取一条素材用于主动说话:随机返回一个词条或一张梗图,梗图会给可直接发送的文件名标记。',
    tags: ['read'],
    parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
  },
  {
    name: 'netlingo_status',
    description: '查看网络语言能力的状态:开关、今日联网次数、今日提醒次数、库存与最近条目。',
    tags: ['read'],
    parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
  },
  {
    name: 'netlingo_switch',
    description: '开关网络语言能力,写回配置并立即生效。关掉后不联网、不收集、不推主动提醒。',
    tags: ['write'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled: { type: 'boolean', description: 'true 打开,false 关闭。' },
      },
      required: ['enabled'],
    },
  },
];

function decl(name: string): Omit<ToolDef, 'handler'> {
  const found = NETLINGO_TOOL_DECLS.find((item) => item.name === name);
  if (!found) throw new Error(`missing tool declaration: ${name}`);
  return found;
}

export class NetlingoWorld implements World {
  readonly id = 'netlingo';

  private readonly cfg: NetlingoConfigSection;
  private readonly timezone: string;
  private readonly botName: string;
  private readonly secret: (name: string) => string;
  private readonly persist: (patch: DeepPartial<NetlingoConfigSection>) => void;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly library: Library;
  private readonly quota: Quota;

  private host?: WorldHost;
  private timer?: ReturnType<typeof setInterval>;
  private lastActivityAt = 0;
  private lastOpportunityAt = 0;
  private quotaWarnedDay = '';
  private emptyNudgedDay = '';
  /** 联网状态:空闲、正在查、上次失败。给 WebUI 的状态灯用。 */
  private netState: 'idle' | 'searching' | 'failed' = 'idle';
  private searching = 0;
  private lastError = '';
  private lastSuccessAt = '';

  constructor(opts: NetlingoWorldOptions) {
    this.cfg = opts.cfg;
    this.timezone = opts.timezone;
    this.botName = opts.botName;
    this.secret = opts.secret;
    this.persist = opts.persist;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.now = opts.now ?? Date.now;
    this.library = new Library(opts.dataDir);
    this.quota = new Quota(opts.dataDir, opts.timezone, this.now);
  }

  /** 只报值;前缀文本一律来自 ENV_PROMPT.md 模板。 */
  envPromptVars(): Record<string, string> {
    const lib = this.library.load();
    const enabled = this.cfg.netLanguageEnabled;
    return {
      'netlingo.today': localDay(new Date(this.now()), this.timezone),
      'netlingo.status': enabled
        ? `已开启;今日联网 ${this.quota.searches} 次,上限 ${this.limitText(this.cfg.dailySearchLimit)};本地有 ${lib.terms.length} 条词条、${lib.memes.length} 张梗图。`
        : '已关闭;不要联网查词或抓图,也不要提这个能力。',
      'netlingo.proactive': this.cfg.proactive.enabled
        ? `打开着:静默满 ${this.cfg.proactive.minIdleMinutes} 分钟会提醒一次,今日已提醒 ${this.quota.opportunities} 次,上限 ${this.limitText(this.cfg.proactive.dailyLimit)}。说不说由你判断。`
        : '关着:不会主动提醒,只在被调用工具时工作。',
      'netlingo.memes': this.memeHint(),
    };
  }

  tools(): ToolDef[] {
    return [
      this.searchTool(),
      this.learnTool(),
      this.recallTool(),
      this.collectMemeTool(),
      this.trendingTool(),
      this.commentsTool(),
      this.captureTool(),
      this.exchangesTool(),
      this.matchTool(),
      this.describeMemeTool(),
      this.pickTool(),
      this.statusTool(),
      this.switchTool(),
    ];
  }

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    return {
      label: '网络语言',
      lamps: [this.lamp(language)],
      config: [NETLINGO_CAPABILITY_GROUP, NETLINGO_SEARCH_GROUP, NETLINGO_VISION_GROUP, NETLINGO_PROACTIVE_GROUP],
      storage: this.storageParts(),
      promptDocs: [
        {
          key: 'worlds.netlingo.envPrompt',
          title: '网络语言 · 环境提示词',
          description: '网络用语与梗这一段进 system 前缀,说明何时查、何时说。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [
            { name: 'netlingo.status', description: '开关与今日用量,此刻的值。' },
            { name: 'netlingo.proactive', description: '主动提醒的配置与今日次数。' },
            { name: 'netlingo.memes', description: '梗图目录与能否直接发送。' },
            { name: 'netlingo.today', description: '本地日期。' },
          ],
        },
      ],
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.lastActivityAt = this.now();
    if (!this.timer) {
      this.timer = setInterval(() => {
        void this.tick();
      }, TICK_MS);
      (this.timer as { unref?: () => void }).unref?.();
    }
    const lib = this.library.load();
    await this.push('netlingo.ready', `网络语言 World 已挂载。${this.statusLine()}`, 'flush');
    host.log.info('netlingo ready', { terms: lib.terms.length, memes: lib.memes.length });
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.host = undefined;
  }

  /** 主循环一轮结束时刷新活动时间;主动提醒的静默从这一刻算。 */
  onTurnEnded(): void {
    this.lastActivityAt = this.now();
  }

  // ---- 后台时机 ----

  /** 定时器每分钟调一次;测试也直接调用它。 */
  async tick(): Promise<void> {
    const host = this.host;
    if (!host) return;
    if (!this.cfg.netLanguageEnabled || !this.cfg.proactive.enabled) return;
    const gapMs = Math.max(5, this.cfg.proactive.minIdleMinutes) * 60_000;
    const since = Math.max(this.lastActivityAt, this.lastOpportunityAt);
    if (this.now() - since < gapMs) return;
    if (!this.quota.canOffer(this.cfg.proactive.dailyLimit)) return;

    const lib = this.library.load();
    if (!lib.terms.length && !lib.memes.length) {
      // 库还空着时每天提醒一次去收集,不按 dailyLimit 反复打扰。
      const today = localDay(new Date(this.now()), this.timezone);
      if (this.emptyNudgedDay === today) return;
      this.emptyNudgedDay = today;
      this.lastOpportunityAt = this.now();
      this.quota.bumpOpportunity();
      await this.push(
        'netlingo.opportunity',
        '【网络语言·时机】本地库还是空的,还没有可用的网络用语或梗图。\n' +
          '遇到看不懂的新词时可以用 netlingo_search 查一次,再用 netlingo_learn 记下来;' +
          '想发图就用 netlingo_collect_meme 收几张。不想做也可以忽略本事件。',
        'flush',
      );
      host.log.info('netlingo empty-library nudge');
      return;
    }

    const item = this.pickItem(lib);
    if (!item) return;
    this.lastOpportunityAt = this.now();
    this.quota.bumpOpportunity();
    const minutes = Math.max(1, Math.round((this.now() - this.lastActivityAt) / 60_000));
    const text =
      `【网络语言·时机】距上次对话结束约 ${minutes} 分钟。\n` +
      `一条可用素材:\n${item.text}\n` +
      `想活跃气氛时可以用它说一句;不想说就忽略本事件,不需要回复。` +
      (item.canSend ? '' : '\n(这张图还没配置梗图另存目录,暂时不能直接发到 QQ。)');
    await this.push('netlingo.opportunity', text, 'flush');
    host.log.info('netlingo opportunity', { minutes });
  }

  // ---- 工具 ----

  private searchTool(): ToolDef {
    return {
      ...decl('netlingo_search'),
      handler: async (args) => {
        const off = this.offMessage();
        if (off) return off;
        const query = textArg(args.query);
        if (!query) return failure('query 不能为空。');
        const limit = this.cfg.dailySearchLimit;
        const slot = this.quota.consumeSearch(limit);
        if (!slot.ok) {
          await this.reportQuotaExhausted();
          return failure(
            `今日联网查找已用完(${slot.used}/${slot.limit})。${this.quota.resetText()},或让操作者调高「每日联网查找次数」。`,
          );
        }
        const maxResults = clampInt(args.maxResults, 1, 10, 5);
        const result = await this.runSearch({
          query,
          endpoint: this.cfg.searchEndpoint,
          apiKey: this.apiKey(),
          maxResults,
          fetchImpl: this.fetchImpl,
        });
        if (!result.ok) {
          return failure(`查询失败:${result.error ?? '未知错误'}。地址:${result.source}(本次已计入当日额度)`);
        }
        if (!result.hits.length) {
          return `没有查到「${query}」的可用结果。来源:${result.source}(本次已计入当日额度 ${slot.used}/${this.limitText(limit)})`;
        }
        const lines = result.hits.map((hit, index) => describeHit(hit, index + 1));
        return (
          `「${query}」查到 ${result.hits.length} 条。本次已计入当日额度 ${slot.used}/${this.limitText(limit)}。\n` +
          `${lines.join('\n')}\n来源:${result.source}\n` +
          '结果可能过时或不准确,引用时说明来源;确认有用可用 netlingo_learn 记下来。'
        );
      },
    };
  }

  private learnTool(): ToolDef {
    return {
      ...decl('netlingo_learn'),
      handler: async (args) => {
        const term = textArg(args.term);
        const meaning = textArg(args.meaning);
        if (!term || !meaning) return failure('term 与 meaning 都不能为空。');
        const lib = this.library.load();
        const entry: TermEntry = {
          term,
          meaning,
          example: textArg(args.example) || undefined,
          sourceUrl: textArg(args.sourceUrl) || undefined,
          tags: stringArray(args.tags).slice(0, 8),
          learnedAt: nowIso(this.timezone),
        };
        const { replaced } = this.library.addTerm(lib, entry);
        this.library.save(lib);
        return `${replaced ? '已覆盖' : '已记下'}「${term}」。本地现有 ${lib.terms.length} 条词条。`;
      },
    };
  }

  private recallTool(): ToolDef {
    return {
      ...decl('netlingo_recall'),
      handler: async (args) => {
        const lib = this.library.load();
        const limit = clampInt(args.limit, 1, 20, 5);
        const query = textArg(args.query);
        let rows: TermEntry[];
        if (query) {
          rows = searchTerms(lib, query, limit);
          if (!rows.length) return `本地库里没有和「${query}」相关的词条。现有 ${lib.terms.length} 条。`;
        } else {
          rows = shuffle(lib.terms).slice(0, limit);
          if (!rows.length) return '本地库还没有词条。可以先用 netlingo_search 查,再用 netlingo_learn 记下来。';
        }
        return rows.map((row, index) => `${index + 1}. ${describeTerm(row)}`).join('\n');
      },
    };
  }

  private collectMemeTool(): ToolDef {
    return {
      ...decl('netlingo_collect_meme'),
      handler: async (args) => {
        const off = this.offMessage();
        if (off) return off;
        const urls = stringArray(args.urls).filter(isHttpUrl);
        const query = textArg(args.query);
        if (!urls.length && !query) return failure('给 urls 或 query,至少一个。');
        const limit = this.cfg.dailySearchLimit;
        const slot = this.quota.consumeSearch(limit);
        if (!slot.ok) {
          await this.reportQuotaExhausted();
          return failure(
            `今日联网查找已用完(${slot.used}/${slot.limit})。${this.quota.resetText()},或让操作者调高「每日联网查找次数」。`,
          );
        }
        const max = clampInt(args.max, 1, 5, 3);
        const caption = textArg(args.caption) || undefined;
        const candidates = urls.length
          ? urls.slice(0, max)
          : await this.imageCandidatesFromSearch(query, max);
        if (!candidates.length) {
          return `没找到可下载的图片。本次已计入当日额度 ${slot.used}/${this.limitText(limit)}。`;
        }
        const saved: MemeEntry[] = [];
        const skipped: string[] = [];
        const lib = this.library.load();
        const dir = this.library.ensureMemeDir();
        for (const url of candidates) {
          if (saved.length >= max) break;
          const got = await downloadImage(url, this.fetchImpl);
          if (!got.ok) {
            skipped.push(`${url}(${got.error})`);
            continue;
          }
          const ext = extensionForMime(got.image.mime);
          const file = `${hash(url)}${ext}`;
          writeFileSync(join(dir, file), got.image.bytes);
          const entry: MemeEntry = {
            file,
            name: caption ?? shortName(url),
            mime: got.image.mime,
            sourceUrl: url,
            caption,
            addedAt: nowIso(this.timezone),
          };
          this.library.addMeme(lib, entry);
          this.copyToStickerDir(file);
          saved.push(entry);
        }
        this.library.save(lib);
        if (!saved.length) {
          return `图片都没下下来。跳过 ${skipped.length} 个:${skipped.join(';')}。本次已计入当日额度 ${slot.used}/${this.limitText(limit)}。`;
        }
        const lines = saved.map((m) => `- ${m.file}(来自 ${m.sourceUrl ?? '未知'}${m.caption ? `;${m.caption}` : ''})`);
        const sendable = this.cfg.stickerOutDir.trim() ? `\n可以直接发:${saved.map((m) => `[表情包:${m.file}]`).join(' ')}` : '';
        const skipText = skipped.length ? `\n跳过 ${skipped.length} 个:${skipped.join(';')}` : '';
        return (
          `存下 ${saved.length} 张梗图,本地现有 ${lib.memes.length} 张。\n${lines.join('\n')}` +
          `${sendable}${skipText}\n本次已计入当日额度 ${slot.used}/${this.limitText(limit)}。`
        );
      },
    };
  }

  private trendingTool(): ToolDef {
    return {
      ...decl('netlingo_trending'),
      handler: async (args) => {
        const off = this.offMessage();
        if (off) return off;
        const limit = clampInt(args.limit, 1, 30, 15);
        const slot = this.quota.consumeSearch(this.cfg.dailySearchLimit);
        if (!slot.ok) {
          await this.reportQuotaExhausted();
          return failure(`今日联网查找已用完(${slot.used}/${slot.limit})。${this.quota.resetText()}。`);
        }
        this.beginNet();
        try {
          const result = await fetchTrending(this.fetchImpl, limit);
          if (!result.ok || !result.value?.length) {
            this.endNet(false, result.error);
            return failure(`没拿到热榜:${result.error ?? '未知错误'}(本次已计入当日额度)`);
          }
          this.endNet(true);
          const lines = result.value.map(
            (item, index) => `${index + 1}. ${item.title}${item.hot ? `(热度 ${item.hot})` : ''}`,
          );
          return (
            `当下热门 ${result.value.length} 条(抖音榜单 + 百度热搜):\n${lines.join('\n')}\n` +
            `挑一个,用 netlingo_comments 去看评论区怎么说话。本次已计入当日额度 ${slot.used}/${this.limitText(this.cfg.dailySearchLimit)}。`
          );
        } catch (err) {
          const detail = describeError(err);
          this.endNet(false, detail);
          return failure(`取热榜失败:${detail}(本次已计入当日额度)`);
        }
      },
    };
  }

  private commentsTool(): ToolDef {
    return {
      ...decl('netlingo_comments'),
      handler: async (args) => {
        const off = this.offMessage();
        if (off) return off;
        const topic = textArg(args.topic);
        const bvidArg = textArg(args.video);
        if (!topic && !bvidArg) return failure('topic 不能为空;也可以直接给 video(BV 号)。');
        const maxThreads = clampInt(args.limit, 1, 10, 3);
        const slot = this.quota.consumeSearch(this.cfg.dailySearchLimit);
        if (!slot.ok) {
          await this.reportQuotaExhausted();
          return failure(`今日联网查找已用完(${slot.used}/${slot.limit})。${this.quota.resetText()}。`);
        }
        this.beginNet();
        try {
          const candidates: BiliVideo[] = [];
          if (bvidArg) {
            candidates.push({
              bvid: bvidArg,
              title: bvidArg,
              play: 0,
              url: `https://www.bilibili.com/video/${bvidArg}`,
            });
          } else {
            const found = await searchBiliVideos(topic, this.fetchImpl, 3);
            if (!found.ok || !found.value?.length) {
              this.endNet(false, found.error);
              return failure(`没找到相关视频:${found.error ?? '没有结果'}(本次已计入当日额度)`);
            }
            candidates.push(...found.value);
          }

          let video: BiliVideo | undefined;
          let thread: BiliThreadResult | undefined;
          for (const candidate of candidates) {
            const got = await fetchBiliThread(candidate.bvid, this.fetchImpl, maxThreads, 20);
            if (got.ok && got.value?.threads.length) {
              video = candidate;
              thread = got.value;
              break;
            }
          }
          if (!video || !thread) {
            this.endNet(false, '相关视频都没有可读的评论');
            return failure('相关视频都没有可读的评论(本次已计入当日额度)');
          }

          const danmaku = thread.cid
            ? await fetchDanmaku(thread.cid, this.fetchImpl, 12)
            : { ok: false, error: '' };
          this.endNet(true);

          let saved = 0;
          if (args.save === true) {
            const lib = this.library.load();
            for (const item of thread.threads) {
              for (const reply of item.replies.slice(0, 5)) {
                this.library.addExchange(lib, {
                  a: item.root.text.slice(0, 200),
                  b: reply.text.slice(0, 200),
                  where: 'B站',
                  topic: topic || undefined,
                  savedAt: nowIso(this.timezone),
                });
                saved += 1;
              }
            }
            this.library.save(lib);
          }

          const replyTotal = thread.threads.reduce((sum, item) => sum + item.replies.length, 0);
          const blocks = thread.threads.map((item, index) => {
            const head = `— 楼 ${index + 1} [赞 ${item.root.like}] ${item.root.text}`;
            if (!item.replies.length) return head;
            return `${head}\n${item.replies.map((reply) => `    ↳ ${reply.text}`).join('\n')}`;
          });
          const danmakuLine =
            danmaku.ok && danmaku.value?.length ? `\n弹幕短句:${danmaku.value.join(' / ')}` : '';
          const danmakuCount = danmaku.ok ? `、${danmaku.value?.length ?? 0} 条弹幕` : '';
          return (
            `【热门评论区】话题「${topic || bvidArg}」→ B 站《${video.title}》${video.play ? `(播放 ${formatCount(video.play)})` : ''}\n` +
            `${blocks.join('\n')}${danmakuLine}\n` +
            `共 ${thread.threads.length} 楼、${replyTotal} 条回复${danmakuCount}。` +
            (saved ? `已存 ${saved} 组对话对进长期库。` : '') +
            `上面是一来一回的原话:看他们怎么接、怎么怼、怎么玩梗。不照抄整句,也不学脏话和攻击性表达;` +
            `看到值得记的接法就用 netlingo_learn 记下来,meaning 写「别人这么说时可以怎么接」。\n` +
            `本次已计入当日额度 ${slot.used}/${this.limitText(this.cfg.dailySearchLimit)}。`
          );
        } catch (err) {
          const detail = describeError(err);
          this.endNet(false, detail);
          return failure(`看评论区失败:${detail}(本次已计入当日额度)`);
        }
      },
    };
  }

  private captureTool(): ToolDef {
    return {
      ...decl('netlingo_capture'),
      handler: async (args) => {
        const a = textArg(args.a);
        const b = textArg(args.b);
        if (!a || !b) return failure('a 与 b 都不能为空:一句挑起的话,一句接住的话。');
        const entry: ExchangeEntry = {
          a: a.slice(0, 200),
          b: b.slice(0, 200),
          where: textArg(args.where) || 'qq群',
          topic: textArg(args.topic) || undefined,
          note: textArg(args.note) || undefined,
          savedAt: nowIso(this.timezone),
        };
        const lib = this.library.load();
        const { replaced } = this.library.addExchange(lib, entry);
        this.library.save(lib);
        return `${replaced ? '已更新' : '已记下'}一组对话对,长期库现有 ${lib.exchanges.length} 组。`;
      },
    };
  }

  private exchangesTool(): ToolDef {
    return {
      ...decl('netlingo_exchanges'),
      handler: async (args) => {
        const lib = this.library.load();
        const limit = clampInt(args.limit, 1, 20, 5);
        const query = textArg(args.query);
        const rows = query ? searchExchanges(lib, query, limit) : shuffle(lib.exchanges).slice(0, limit);
        if (!rows.length) {
          return query
            ? `长期库里没有和「${query}」相关的对话对。现有 ${lib.exchanges.length} 组。`
            : '长期库还没有对话对。群里看到有意思的一来一回,用 netlingo_capture 记下来。';
        }
        return rows.map((row, index) => `${index + 1}. ${describeExchange(row)}`).join('\n');
      },
    };
  }

  private matchTool(): ToolDef {
    return {
      ...decl('netlingo_match'),
      handler: async (args) => {
        const text = textArg(args.text);
        if (!text) return failure('text 不能为空:把群友那句话原样发进来。');
        const lib = this.library.load();
        const limit = clampInt(args.limit, 1, 10, 5);
        const exchanges = matchExchanges(lib, text, limit);
        const terms = matchTerms(lib, text, limit);
        if (!exchanges.length && !terms.length) {
          return `库里没有和「${text}」对得上的词条或对话对。按平常回就行;觉得是好料就用 netlingo_capture 记下来。`;
        }
        const lines: string[] = [];
        for (const item of exchanges) {
          const how = item.kind === 'exact' ? '原话命中' : '近似命中';
          lines.push(
            `【对话对·${how}】群友说「${item.entry.a}」→ 可以接「${item.entry.b}」` +
              (item.entry.note ? `\n   手法:${item.entry.note}` : ''),
          );
        }
        for (const item of terms) {
          lines.push(
            `【词条命中】「${item.term}」:${item.meaning}` +
              (item.example ? `\n   例句:${item.example}` : ''),
          );
        }
        return (
          `${lines.join('\n')}\n\n` +
          '词条是群友已经在用的说法,顺着再用一次不奇怪,不必刻意回避;对话对接下一句就行,别整段照抄。'
        );
      },
    };
  }

  private describeMemeTool(): ToolDef {
    return {
      ...decl('netlingo_describe_meme'),
      handler: async (args) => {
        const off = this.offMessage();
        if (off) return off;
        const settings = this.visionSettings();
        if (!settings.enabled) return failure('看图没开启:在设置里打开「看图」,填端点、模型与密钥名。');
        if (!settings.endpoint.trim()) return failure('视觉端点没填(worlds.netlingo.vision.endpoint)。');
        if (!settings.model.trim()) return failure('视觉模型没填(worlds.netlingo.vision.model)。');
        if (!settings.apiKey) {
          return failure(
            `视觉密钥是空的:检查部署 .env 里有没有 ${this.cfg.vision.apiKeySecret || 'NETLINGO_VISION_KEY'}。`,
          );
        }

        const lib = this.library.load();
        const fileArg = textArg(args.file);
        const limit = clampInt(args.limit, 1, 10, 3);
        const candidates = fileArg
          ? lib.memes.filter((item) => item.file === fileArg)
          : lib.memes.filter((item) => !item.description);
        if (!candidates.length) {
          return fileArg
            ? `库里没有这张图:${fileArg}。现有 ${lib.memes.length} 张。`
            : `库里 ${lib.memes.length} 张梗图都已经有描述了。`;
        }

        const done: string[] = [];
        const failed: string[] = [];
        for (const meme of candidates.slice(0, limit)) {
          const path = join(this.library.memeDir(), meme.file);
          if (!existsSync(path)) {
            failed.push(`${meme.file}(文件不在)`);
            continue;
          }
          const result = await describeImage(readFileSync(path), meme.mime, settings, this.fetchImpl);
          if (result.ok && result.text) {
            meme.description = result.text;
            done.push(`${meme.file}:${result.text}`);
          } else {
            failed.push(`${meme.file}(${result.error ?? '未知错误'})`);
          }
        }
        if (done.length) this.library.save(lib);

        const still = lib.memes.filter((item) => !item.description).length;
        return [
          done.length ? `已描述 ${done.length} 张:\n${done.map((item) => `- ${item}`).join('\n')}` : '这次一张也没描述成。',
          failed.length ? `失败 ${failed.length} 张:${failed.join(';')}` : '',
          `库里共 ${lib.memes.length} 张,还有 ${still} 张没描述。`,
        ]
          .filter(Boolean)
          .join('\n');
      },
    };
  }

  private pickTool(): ToolDef {
    return {
      ...decl('netlingo_pick'),
      handler: async () => {
        const lib = this.library.load();
        const item = this.pickItem(lib);
        if (!item) return '本地库还是空的。先用 netlingo_search 查、netlingo_learn 记,或用 netlingo_collect_meme 收图。';
        return item.text + (item.canSend ? '' : '\n(这张图还没配置梗图另存目录,暂时不能直接发到 QQ。)');
      },
    };
  }

  private statusTool(): ToolDef {
    return {
      ...decl('netlingo_status'),
      handler: async () => this.statusLine(true),
    };
  }

  private switchTool(): ToolDef {
    return {
      ...decl('netlingo_switch'),
      handler: async (args) => {
        const enabled = args.enabled === true;
        this.persist({ netLanguageEnabled: enabled });
        return enabled
          ? '网络语言能力已打开,立即生效:可以联网查词、收集梗图,静默一段时间后会收到主动提醒。'
          : '网络语言能力已关闭,立即生效:不再联网、不收集、不推主动提醒;本地库里已有的条目仍可读。';
      },
    };
  }

  // ---- 内部 ----

  /** World 页「数据」页签:库的位置、规模与清除入口。 */
  private storageParts(): StoragePart[] {
    return [
      {
        key: 'netlingo-library',
        label: '词条与梗图',
        kind: 'disk',
        location: this.library.path(),
        danger: true,
        note: '清除后词条与梗图不可恢复,梗图文件一并删除。',
        stat: () => {
          const lib = this.library.load();
          return `词条 ${lib.terms.length} 条、梗图 ${lib.memes.length} 张`;
        },
        clear: () => {
          const lib = this.library.load();
          lib.terms = [];
          lib.memes = [];
          this.library.save(lib);
          rmSync(this.library.memeDir(), { recursive: true, force: true });
          return '已清空词条与梗图。';
        },
      },
      {
        key: 'netlingo-exchanges',
        label: '对话对',
        kind: 'disk',
        location: this.library.path(),
        note: '只清对话对,词条与梗图保留。',
        stat: () => `对话对 ${this.library.load().exchanges.length} 组`,
        clear: () => {
          const lib = this.library.load();
          lib.exchanges = [];
          this.library.save(lib);
          return '已清空对话对。';
        },
      },
    ];
  }

  /** 联网状态灯:关闭=offline,查询中=loading,上次失败=error,其余=online。 */
  private lamp(language: Language): WorldLamp {
    const zh = language.startsWith('zh');
    const label = zh ? '联网' : 'Network';
    if (!this.cfg.netLanguageEnabled) {
      return { label, state: 'offline', hint: zh ? '网络语言能力已关闭' : 'The slang ability is off' };
    }
    if (this.searching > 0) {
      return { label, state: 'loading', hint: zh ? '正在查询' : 'Searching' };
    }
    if (this.netState === 'failed') {
      return {
        label,
        state: 'error',
        hint: zh ? `上次查询失败:${this.lastError}` : `Last search failed: ${this.lastError}`,
      };
    }
    const quota = `${this.quota.searches}/${this.limitText(this.cfg.dailySearchLimit)}`;
    return {
      label,
      state: 'online',
      hint: zh
        ? `空闲;今日联网 ${quota}${this.lastSuccessAt ? `;上次成功 ${this.lastSuccessAt}` : ''}`
        : `Idle; today ${quota}${this.lastSuccessAt ? `; last ok ${this.lastSuccessAt}` : ''}`,
    };
  }

  /** 所有联网查询都走这里,状态灯与回执口径一致。 */
  private async runSearch(opts: SearchOptions): Promise<SearchResult> {
    this.beginNet();
    try {
      const result = await searchWeb(opts);
      this.endNet(result.ok, result.error);
      return result;
    } catch (err) {
      this.endNet(false, describeError(err));
      throw err;
    }
  }

  private beginNet(): void {
    this.searching += 1;
    this.netState = 'searching';
  }

  private endNet(ok: boolean, error?: string): void {
    this.searching = Math.max(0, this.searching - 1);
    if (ok) {
      this.netState = 'idle';
      this.lastError = '';
      this.lastSuccessAt = this.hhmm();
    } else {
      this.netState = 'failed';
      this.lastError = error ?? '未知错误';
    }
  }

  private hhmm(): string {
    try {
      return new Intl.DateTimeFormat('zh-CN', {
        timeZone: this.timezone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date(this.now()));
    } catch {
      return new Date(this.now()).toISOString().slice(11, 16);
    }
  }

  private pickItem(lib: LibraryFile): { text: string; canSend: boolean } | null {
    const total = lib.terms.length + lib.memes.length + lib.exchanges.length;
    if (!total) return null;
    const roll = Math.random() * total;
    if (roll < lib.terms.length) {
      return { text: describeTerm(lib.terms[randInt(lib.terms.length)]), canSend: true };
    }
    if (roll < lib.terms.length + lib.exchanges.length) {
      return { text: describeExchange(lib.exchanges[randInt(lib.exchanges.length)]), canSend: true };
    }
    const meme = lib.memes[randInt(lib.memes.length)];
    const canSend = !!this.cfg.stickerOutDir.trim();
    const note = meme.description ?? meme.caption;
    return {
      text: `【梗图】${meme.file}${note ? `(${note})` : ''}\n来源:${meme.sourceUrl ?? '本地'}`,
      canSend,
    };
  }

  private async imageCandidatesFromSearch(query: string, max: number): Promise<string[]> {
    const result = await this.runSearch({
      query,
      endpoint: this.cfg.searchEndpoint,
      apiKey: this.apiKey(),
      maxResults: Math.min(MAX_PAGE_CANDIDATES, Math.max(max, 3)),
      fetchImpl: this.fetchImpl,
    });
    if (!result.ok) return [];
    const found: string[] = [];
    for (const hit of result.hits.slice(0, MAX_PAGE_CANDIDATES)) {
      const image = await this.pageImage(hit);
      if (image && !found.includes(image)) found.push(image);
      if (found.length >= max) break;
    }
    return found;
  }

  private async pageImage(hit: SearchHit): Promise<string | null> {
    try {
      const response = await this.fetchImpl(hit.url, {
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; CorticoNetlingo/0.1)' },
        signal: AbortSignal.timeout(8_000),
        redirect: 'follow',
      });
      if (!response.ok) return null;
      const type = response.headers.get('content-type') ?? '';
      if (!type.includes('html')) return null;
      return findPageImage(await response.text(), hit.url);
    } catch {
      return null;
    }
  }

  private copyToStickerDir(file: string): void {
    const dir = this.cfg.stickerOutDir.trim();
    if (!dir) return;
    try {
      const target = join(dir, file);
      if (!existsSync(target)) copyFileSync(join(this.library.memeDir(), file), target);
    } catch {
      // 目标目录不可写时不打断收集,回执里的「可以直接发」可能因此不成立。
    }
  }

  private visionSettings(): VisionSettings {
    const name = this.cfg.vision.apiKeySecret.trim();
    let apiKey = '';
    if (name) {
      try {
        apiKey = this.secret(name) ?? '';
      } catch {
        apiKey = '';
      }
    }
    return {
      enabled: this.cfg.vision.enabled,
      endpoint: this.cfg.vision.endpoint,
      apiKey,
      model: this.cfg.vision.model,
    };
  }

  private apiKey(): string {
    const name = this.cfg.searchApiKeyName.trim();
    if (!name) return '';
    try {
      return this.secret(name) ?? '';
    } catch {
      return '';
    }
  }

  private offMessage(): ToolOutcome | null {
    if (this.cfg.netLanguageEnabled) return null;
    return failure('网络语言能力当前是关闭的。需要先打开:让操作者在设置里开,或用 netlingo_switch 打开。');
  }

  private statusLine(detailed = false): string {
    const lib = this.library.load();
    const head =
      `网络语言能力:${this.cfg.netLanguageEnabled ? '开' : '关'};` +
      `今日联网 ${this.quota.searches}/${this.limitText(this.cfg.dailySearchLimit)};` +
      `今日提醒 ${this.quota.opportunities}/${this.limitText(this.cfg.proactive.dailyLimit)};` +
      `词条 ${lib.terms.length} 条,梗图 ${lib.memes.length} 张,对话对 ${lib.exchanges.length} 组。`;
    if (!detailed) return head;
    const recentTerms = lib.terms.slice(-3).map((t) => t.term);
    const recentMemes = lib.memes.slice(-3).map((m) => m.file);
    const recentExchanges = lib.exchanges.slice(-2).map((e) => `${e.a} / ${e.b}`);
    return (
      `${head}\n主动提醒:${this.cfg.proactive.enabled ? `开,静默 ${this.cfg.proactive.minIdleMinutes} 分钟触发` : '关'}\n` +
      `最近词条:${recentTerms.length ? recentTerms.join('、') : '(无)'}\n` +
      `最近梗图:${recentMemes.length ? recentMemes.join('、') : '(无)'}\n` +
      `最近对话对:${recentExchanges.length ? recentExchanges.join(' | ') : '(无)'}\n` +
      `${this.memeHint()}`
    );
  }

  private memeHint(): string {
    const dir = this.cfg.stickerOutDir.trim();
    return dir
      ? `梗图另存目录已配置,收集到的图会复制过去,可直接用 [表情包:文件名] 发送。`
      : '梗图另存目录没配,收集到的图只在本机数据目录,不能直接用 [表情包:文件名] 发到 QQ。';
  }

  private limitText(limit: number): string {
    return limit > 0 ? String(limit) : '不限';
  }

  private async push(type: string, text: string, trigger: 'flush' | 'piggyback'): Promise<void> {
    const host = this.host;
    if (!host) return;
    await host.pushEvent(
      {
        type,
        ts: nowIso(this.timezone),
        source: this.id,
        origin: 'internal',
        senderKey: this.id,
        text,
      },
      { trigger },
    );
  }

  private async reportQuotaExhausted(): Promise<void> {
    const day = this.quota.today();
    if (this.quotaWarnedDay === day) return;
    this.quotaWarnedDay = day;
    await this.push(
      'netlingo.quota_exhausted',
      `今日联网查找次数已用完(${this.cfg.dailySearchLimit} 次)。${this.quota.resetText()},或让操作者调高「每日联网查找次数」。`,
      'piggyback',
    );
  }
}

function describeHit(hit: SearchHit, index: number): string {
  const snippet = hit.snippet ? `\n   ${hit.snippet}` : '';
  return `${index}. ${hit.title}${snippet}\n   ${hit.url}`;
}

function describeTerm(row: TermEntry): string {
  const parts = [`【网络用语】${row.term}`, `含义:${row.meaning}`];
  if (row.example) parts.push(`例句:${row.example}`);
  if (row.sourceUrl) parts.push(`来源:${row.sourceUrl}`);
  if (row.tags?.length) parts.push(`标签:${row.tags.join('、')}`);
  return parts.join('\n');
}

function describeExchange(row: ExchangeEntry): string {
  const head = `【对话对·${row.where}${row.topic ? `·${row.topic}` : ''}】`;
  const note = row.note ? `\n   备注:${row.note}` : '';
  return `${head}\n   甲:${row.a}\n   乙:${row.b}${note}`;
}

function textArg(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean)
    : [];
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function hash(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 12);
}

function shortName(url: string): string {
  try {
    const path = new URL(url).pathname;
    const last = path.split('/').filter(Boolean).pop() ?? '';
    return last.replace(/\.[a-z0-9]+$/i, '') || new URL(url).hostname;
  } catch {
    return 'meme';
  }
}

function randInt(length: number): number {
  return Math.min(length - 1, Math.floor(Math.random() * length));
}

function shuffle<T>(items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = copy[i];
    copy[i] = copy[j];
    copy[j] = a;
  }
  return copy;
}

function formatCount(value: number): string {
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1)} 亿`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(1)} 万`;
  return String(value);
}

function failure(text: string): ToolOutcome {
  return { text, failed: true };
}
