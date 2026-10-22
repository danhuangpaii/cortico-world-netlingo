import type { ConfigGroup } from 'cortico/core/types.ts';

/** `worlds.netlingo` 段。`enabled` 是 World 开关,`netLanguageEnabled` 是功能开关。 */
export interface NetlingoProactiveSection {
  /** 是否推送主动机会事件。 */
  enabled: boolean;
  /** 距上次活动至少多少分钟才推一次。 */
  minIdleMinutes: number;
  /** 每日最多推几次,0 表示不限。 */
  dailyLimit: number;
}

export interface NetlingoConfigSection {
  enabled: boolean;
  /** 用户开关:关掉后不联网、不收集、不推机会事件。 */
  netLanguageEnabled: boolean;
  /** 每日联网查找次数,0 表示不限。查词与抓图各算一次。 */
  dailySearchLimit: number;
  /** 自定义搜索端点,留空用内置的 DuckDuckGo HTML 页。 */
  searchEndpoint: string;
  /** 搜索端点密钥的名字,值在部署 .env;留空表示不需要。 */
  searchApiKeyName: string;
  /** 抓到的图额外复制一份到这里;填 QQ 表情包目录后 `[表情包:文件名]` 直接可用。 */
  stickerOutDir: string;
  proactive: NetlingoProactiveSection;
}

export const NETLINGO_DEFAULTS: NetlingoConfigSection = {
  enabled: false,
  netLanguageEnabled: true,
  dailySearchLimit: 10,
  searchEndpoint: '',
  searchApiKeyName: '',
  stickerOutDir: '',
  proactive: { enabled: true, minIdleMinutes: 45, dailyLimit: 3 },
};

export const NETLINGO_CAPABILITY_GROUP: ConfigGroup = {
  id: 'world:netlingo',
  owner: 'world:netlingo',
  schema: {
    type: 'object',
    title: '网络语言',
    description: '联网学习网络用语与梗图,并在合适的时机提醒 bot 可以用它们说话。',
    properties: {
      'worlds.netlingo.netLanguageEnabled': {
        type: 'boolean',
        title: '网络语言能力',
        description: '关掉后不联网、不收集、不推主动机会事件;本地库里已有的条目仍可读。',
        'x-hot': true,
      },
      'worlds.netlingo.dailySearchLimit': {
        type: 'integer',
        title: '每日联网查找次数',
        minimum: 0,
        maximum: 200,
        description: '0 表示不限。查词与抓图各算一次,按本地日期重置。',
        'x-hot': true,
      },
    },
  },
};

export const NETLINGO_SEARCH_GROUP: ConfigGroup = {
  id: 'world:netlingo:search',
  owner: 'world:netlingo',
  schema: {
    type: 'object',
    title: '联网查找',
    description: '搜索走哪里、图片抓下来放哪。',
    properties: {
      'worlds.netlingo.searchEndpoint': {
        type: 'string',
        title: '搜索端点',
        description: '留空用内置搜索(360→搜狗→Bing RSS→DuckDuckGo 依次尝试)。填了按 `q` 参数请求,JSON 与 HTML 两种响应都认。',
        'x-hot': true,
      },
      'worlds.netlingo.searchApiKeyName': {
        type: 'string',
        title: '搜索端点密钥名',
        description: '只填名字,值写在部署 .env,例如 NETLINGO_SEARCH_KEY;留空表示端点不需要密钥。',
        'x-hot': true,
      },
      'worlds.netlingo.stickerOutDir': {
        type: 'string',
        title: '梗图另存目录',
        description: '抓到的图额外复制一份到这里。填 QQ 的表情包目录,就能用 `[表情包:文件名]` 发送。',
        'x-path': { kind: 'directory' },
        'x-hot': true,
      },
    },
  },
};

export const NETLINGO_PROACTIVE_GROUP: ConfigGroup = {
  id: 'world:netlingo:proactive',
  owner: 'world:netlingo',
  schema: {
    type: 'object',
    title: '主动时机',
    description: '什么时候提醒 bot 可以用一条网络用语或梗图说话。说与不说仍由 bot 判断。',
    properties: {
      'worlds.netlingo.proactive.enabled': {
        type: 'boolean',
        title: '推送主动机会',
        description: '关掉后只响应工具调用,不主动提醒。',
        'x-hot': true,
      },
      'worlds.netlingo.proactive.minIdleMinutes': {
        type: 'integer',
        title: '静默多少分钟后提醒',
        minimum: 5,
        maximum: 1440,
        description: '距上次对话结束或上次提醒满这么多分钟,才推下一次。',
        'x-hot': true,
      },
      'worlds.netlingo.proactive.dailyLimit': {
        type: 'integer',
        title: '每日提醒上限',
        minimum: 0,
        maximum: 50,
        description: '0 表示不限。',
        'x-hot': true,
      },
    },
  },
};
