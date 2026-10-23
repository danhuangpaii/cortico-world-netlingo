import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { NETLINGO_DEFAULTS, type NetlingoConfigSection } from './config.ts';
import { NETLINGO_TOOL_DECLS, NetlingoWorld } from './world.ts';

export const NETLINGO: WorldDefinition<NetlingoConfigSection> = {
  id: 'netlingo',
  label: '网络语言',
  defaults: () => ({ ...NETLINGO_DEFAULTS, proactive: { ...NETLINGO_DEFAULTS.proactive } }),
  // `ctx.cfg` 是 `worlds.netlingo` 的活引用:热改的键现读即生效。
  create: (ctx) =>
    new NetlingoWorld({
      cfg: ctx.cfg,
      timezone: ctx.timezone,
      dataDir: ctx.dataDir,
      botName: ctx.botName,
      secret: (name) => ctx.secret(name),
      persist: (patch) => ctx.persist(patch),
    }),
  // 自描述:可能出现的全部工具与会推出的全部事件,不进提示词。
  describe: {
    tools: describeTools(NETLINGO_TOOL_DECLS, {
      netlingo_search: { zh: '联网查一个网络用语在群聊里怎么用,扣一次每日额度。', en: 'Searches the web for how a slang term is used in chat and spends one daily lookup.' },
      netlingo_learn: { zh: '把词、含义、例句与来源记进本地库。', en: 'Stores a term, its meaning, an example and a source in the local library.' },
      netlingo_recall: { zh: '按关键词或随机检索本地词条。', en: 'Looks up local terms by keyword, or picks some at random.' },
      netlingo_collect_meme: { zh: '从图片地址或搜索结果页收集梗图。', en: 'Collects meme images from URLs or from the og:image of search results.' },
      netlingo_trending: { zh: '看当下热门话题,挑一个再去看评论区。', en: 'Lists today trending topics so the bot can pick one and read its comments.' },
      netlingo_comments: { zh: '抓一个话题在 B 站的热门评论原话。', en: 'Fetches top comments from Bilibili for a topic.' },
      netlingo_capture: { zh: '把群里一来一回的两句原话记进长期库。', en: 'Stores a two-line exchange from a group chat.' },
      netlingo_exchanges: { zh: '翻长期库里的对话对。', en: 'Looks up saved exchanges.' },
      netlingo_match: { zh: '拿群聊原话查库:命中对话对给下一句,命中词条说明可以再用。', en: 'Matches a chat line against the library and offers the next line or the stored term.' },
      netlingo_import_chat: { zh: '从事件库读群里的聊天记录,把一来一回存进长期库。', en: 'Reads shared chat records from the event store and keeps the exchanges.' },
      netlingo_label_sticker: { zh: '给表情包记下适合什么气氛与场合。', en: 'Records which mood or occasion a sticker suits.' },
      netlingo_sticker_for: { zh: '按当前气氛找一张该发的表情包。', en: 'Finds a sticker that fits the current mood.' },
      netlingo_pick: { zh: '随机取一条词条、梗图或对话对用于主动说话。', en: 'Picks one term, meme or exchange to use when speaking up.' },
      netlingo_status: { zh: '报告开关、今日用量与库存。', en: 'Reports the switch, today usage and library size.' },
      netlingo_switch: { zh: '开关网络语言能力并立即生效。', en: 'Turns the slang ability on or off, taking effect immediately.' },
    }),
    events: [
      {
        type: 'netlingo.ready',
        description: { zh: 'World 挂载完成,报告开关、库存与今日额度。', en: 'The World was mounted; reports the switch, library size and today quota.' },
      },
      {
        type: 'netlingo.opportunity',
        description: {
          zh: '静默满设定时长后提醒一次:有素材时附一条网络用语或梗图,库空时建议去收集。',
          en: 'After the configured idle time, offers one term or meme, or suggests collecting some when the library is empty.',
        },
        trigger: 'flush',
      },
      {
        type: 'netlingo.quota_exhausted',
        description: { zh: '当日联网查找次数用尽,当天只报一次。', en: 'Today web lookup quota is exhausted; reported once per day.' },
        trigger: 'piggyback',
      },
    ],
  },
};
