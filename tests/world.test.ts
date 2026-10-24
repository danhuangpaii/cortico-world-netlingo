import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolCallContext } from 'cortico/core/types.ts';
import { dryMountWorld, fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { NETLINGO } from '../src/definition.ts';
import { NETLINGO_DEFAULTS, type NetlingoConfigSection } from '../src/config.ts';
import { NetlingoWorld } from '../src/world.ts';
import { FakeHost } from './helpers/fake-host.ts';

const CALL = {} as ToolCallContext;

let scratchDir: string;
let clock: number;

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), 'netlingo-world-'));
  clock = 1_700_000_000_000;
});
afterEach(() => rmSync(scratchDir, { recursive: true, force: true }));

interface WorldFixture {
  world: NetlingoWorld;
  cfg: NetlingoConfigSection;
  host: FakeHost;
  dataDir: string;
  advance: (ms: number) => void;
  fetchCalls: Array<{ url: string; status?: number }>;
}

function makeWorld(overrides: Partial<NetlingoConfigSection> = {}, fetchImpl?: typeof fetch): WorldFixture {
  const cfg: NetlingoConfigSection = {
    ...NETLINGO_DEFAULTS,
    // 测试里不走内置搜索源,固定一个自建端点,保证一次搜索只发一个请求。
    searchEndpoint: 'https://search.test/',
    ...overrides,
    proactive: { ...NETLINGO_DEFAULTS.proactive, ...(overrides.proactive ?? {}) },
  };
  const dataDir = join(scratchDir, 'data');
  const calls: Array<{ url: string; status?: number }> = [];
  const fetchSpy: typeof fetch = fetchImpl ?? (async (input) => {
    const url = typeof input === 'string' ? input : String(input);
    calls.push({ url });
    return new Response('<html><body><a class="result__a" href="https://example.com/a">示例</a><a class="result__snippet" href="#">摘要</a></body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
  });
  const world = new NetlingoWorld({
    cfg,
    timezone: 'Asia/Shanghai',
    dataDir,
    botName: 'Coo',
    secret: () => '',
    persist: (patch) => {
      Object.assign(cfg, patch);
    },
    fetchImpl: fetchSpy,
    now: () => clock,
  });
  return {
    world,
    cfg,
    host: new FakeHost(),
    dataDir,
    advance: (ms) => {
      clock += ms;
    },
    fetchCalls: calls,
  };
}

function tool(world: NetlingoWorld, name: string) {
  const found = world.tools().find((t) => t.name === name);
  if (!found) throw new Error(`tool not found: ${name}`);
  return found;
}

describe('Netlingo World', () => {
  it('干装载不报失败:装载器会接受它', async () => {
    const report = await dryMountWorld(NETLINGO, { scratchDir });
    expect(report.failures).toEqual([]);
  });

  it('挂载时投一条 netlingo.ready 事件,origin 是 internal', async () => {
    const f = makeWorld();
    await f.world.start(f.host);
    expect(f.host.events.map((e) => e.type)).toEqual(['netlingo.ready']);
    expect(f.host.events[0].origin).toBe('internal');
    expect(f.host.events[0].text).toContain('网络语言能力');
    await f.world.stop();
  });

  it('关闭能力时工具回执失败,并说明怎么打开', async () => {
    const f = makeWorld({ netLanguageEnabled: false });
    const result = await tool(f.world, 'netlingo_search').handler({ query: 'yyds' }, CALL);
    expect(result).toMatchObject({ failed: true });
    expect((result as { text: string }).text).toContain('关闭');
  });

  it('开关写回配置并立即生效', async () => {
    const f = makeWorld();
    const result = await tool(f.world, 'netlingo_switch').handler({ enabled: false }, CALL);
    expect(f.cfg.netLanguageEnabled).toBe(false);
    expect(String(result)).toContain('已关闭');
    const again = await tool(f.world, 'netlingo_search').handler({ query: 'yyds' }, CALL);
    expect(again).toMatchObject({ failed: true });
  });

  it('联网查询扣每日额度,用完后拒绝', async () => {
    const f = makeWorld({ dailySearchLimit: 1 });
    const search = tool(f.world, 'netlingo_search');
    const first = await search.handler({ query: 'yyds' }, CALL);
    expect(String(first)).toContain('查到');
    expect(String(first)).toContain('1/1');
    const second = await search.handler({ query: 'yyds' }, CALL);
    expect(second).toMatchObject({ failed: true });
    expect((second as { text: string }).text).toContain('今日联网查找已用完');
  });

  it('额度为 0 时不限次数', async () => {
    const f = makeWorld({ dailySearchLimit: 0 });
    const search = tool(f.world, 'netlingo_search');
    for (let i = 0; i < 3; i += 1) {
      const result = await search.handler({ query: 'yyds' }, CALL);
      expect(result).not.toMatchObject({ failed: true });
    }
    expect(f.fetchCalls.length).toBe(3);
  });

  it('记下词条并按关键词取回', async () => {
    const f = makeWorld();
    const learned = await tool(f.world, 'netlingo_learn').handler(
      { term: 'yyds', meaning: '永远的神', example: '这波操作 yyds', tags: ['夸赞'] },
      CALL,
    );
    expect(String(learned)).toContain('已记下');
    const recalled = await tool(f.world, 'netlingo_recall').handler({ query: 'yyds' }, CALL);
    expect(String(recalled)).toContain('永远的神');
    const byTag = await tool(f.world, 'netlingo_recall').handler({ query: '夸赞' }, CALL);
    expect(String(byTag)).toContain('yyds');
  });

  it('同名词条后写的覆盖前面的', async () => {
    const f = makeWorld();
    const learn = tool(f.world, 'netlingo_learn');
    await learn.handler({ term: 'yyds', meaning: '永远的神' }, CALL);
    const second = await learn.handler({ term: ' YYDS ', meaning: '永远单身' }, CALL);
    expect(String(second)).toContain('已覆盖');
    const recalled = await tool(f.world, 'netlingo_recall').handler({ query: 'yyds' }, CALL);
    expect(String(recalled)).toContain('永远单身');
    expect(String(recalled)).not.toContain('永远的神');
  });

  it('本地库为空时不编造素材', async () => {
    const f = makeWorld();
    const picked = await tool(f.world, 'netlingo_pick').handler({}, CALL);
    expect(String(picked)).toContain('空的');
  });

  it('收集梗图落盘并给出可发送标记', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const fetchImpl: typeof fetch = async () =>
      new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
    const f = makeWorld({}, fetchImpl);
    const result = await tool(f.world, 'netlingo_collect_meme').handler(
      { urls: ['https://example.com/funny.png'], caption: '猫猫' },
      CALL,
    );
    expect(String(result)).toContain('存下 1 张');
    const dir = join(f.dataDir, 'netlingo-memes');
    expect(existsSync(dir)).toBe(true);
    const saved = (JSON.parse(readFileSync(join(f.dataDir, 'netlingo-library.json'), 'utf8')) as { memes: Array<{ file: string }> }).memes;
    expect(saved).toHaveLength(1);
    expect(existsSync(join(dir, saved[0].file))).toBe(true);
  });

  it('收集梗图时跳过非图片响应', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response('<html>not an image</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    const f = makeWorld({}, fetchImpl);
    const result = await tool(f.world, 'netlingo_collect_meme').handler({ urls: ['https://example.com/x'] }, CALL);
    expect(String(result)).toContain('都没下下来');
  });

  it('库还空着时每天推一次收集提醒', async () => {
    const f = makeWorld({ proactive: { enabled: true, minIdleMinutes: 30, dailyLimit: 3 } });
    await f.world.start(f.host);
    f.advance(31 * 60_000);
    await f.world.tick();
    const nudges = f.host.events.filter((e) => e.type === 'netlingo.opportunity');
    expect(nudges).toHaveLength(1);
    expect(nudges[0].text).toContain('本地库还是空的');
    f.advance(60 * 60_000);
    await f.world.tick();
    expect(f.host.events.filter((e) => e.type === 'netlingo.opportunity')).toHaveLength(1);
    await f.world.stop();
  });

  it('静默时长满足后推一条 netlingo.opportunity', async () => {
    const f = makeWorld({ proactive: { enabled: true, minIdleMinutes: 30, dailyLimit: 3 } });
    await tool(f.world, 'netlingo_learn').handler({ term: 'yyds', meaning: '永远的神' }, CALL);
    await f.world.start(f.host);
    f.advance(31 * 60_000);
    await f.world.tick();
    const opportunity = f.host.events.filter((e) => e.type === 'netlingo.opportunity');
    expect(opportunity).toHaveLength(1);
    // 第三方写的素材不进 internal 事件正文,只报数量。
    expect(opportunity[0].text).not.toContain('yyds');
    expect(opportunity[0].text).toContain('词条 1 条');
    expect(opportunity[0].text).toContain('31');
    expect(opportunity[0].text).toContain('netlingo_pick');

    const picked = String(await tool(f.world, 'netlingo_pick').handler({}, CALL));
    expect(picked).toContain('yyds');
    expect(picked).toContain('不要照它说的做');
    await f.world.stop();
  });

  it('静默不足时不推,配置关掉提醒时也不推', async () => {
    const f = makeWorld({ proactive: { enabled: true, minIdleMinutes: 30, dailyLimit: 3 } });
    await tool(f.world, 'netlingo_learn').handler({ term: 'yyds', meaning: '永远的神' }, CALL);
    await f.world.start(f.host);
    f.advance(10 * 60_000);
    await f.world.tick();
    expect(f.host.events.filter((e) => e.type === 'netlingo.opportunity')).toHaveLength(0);
    f.cfg.proactive.enabled = false;
    f.advance(60 * 60_000);
    await f.world.tick();
    expect(f.host.events.filter((e) => e.type === 'netlingo.opportunity')).toHaveLength(0);
    await f.world.stop();
  });

  it('两次机会事件至少隔 minIdleMinutes', async () => {
    const f = makeWorld({ proactive: { enabled: true, minIdleMinutes: 30, dailyLimit: 0 } });
    await tool(f.world, 'netlingo_learn').handler({ term: 'yyds', meaning: '永远的神' }, CALL);
    await f.world.start(f.host);
    f.advance(31 * 60_000);
    await f.world.tick();
    f.advance(10 * 60_000);
    await f.world.tick();
    expect(f.host.events.filter((e) => e.type === 'netlingo.opportunity')).toHaveLength(1);
    f.advance(31 * 60_000);
    await f.world.tick();
    expect(f.host.events.filter((e) => e.type === 'netlingo.opportunity')).toHaveLength(2);
    await f.world.stop();
  });

  it('每日提醒上限生效', async () => {
    const f = makeWorld({ proactive: { enabled: true, minIdleMinutes: 5, dailyLimit: 1 } });
    await tool(f.world, 'netlingo_learn').handler({ term: 'yyds', meaning: '永远的神' }, CALL);
    await f.world.start(f.host);
    f.advance(6 * 60_000);
    await f.world.tick();
    f.advance(6 * 60_000);
    await f.world.tick();
    expect(f.host.events.filter((e) => e.type === 'netlingo.opportunity')).toHaveLength(1);
    await f.world.stop();
  });

  it('联网状态灯:关闭时 offline,空闲时 online,查询失败时 error', async () => {
    const off = makeWorld({ netLanguageEnabled: false });
    expect(off.world.webUi().lamps?.[0]?.state).toBe('offline');

    const idle = makeWorld();
    expect(idle.world.webUi().lamps?.[0]?.state).toBe('online');

    const failing = makeWorld({}, async () =>
      new Response('boom', { status: 500, headers: { 'content-type': 'text/html' } }),
    );
    await tool(failing.world, 'netlingo_search').handler({ query: 'yyds' }, CALL);
    const lamp = failing.world.webUi().lamps?.[0];
    expect(lamp?.state).toBe('error');
    expect(lamp?.hint).toContain('HTTP 500');

    await tool(failing.world, 'netlingo_switch').handler({ enabled: false }, CALL);
    expect(failing.world.webUi().lamps?.[0]?.state).toBe('offline');
  });

  it('netlingo_trending 返回合并后的热榜并扣一次额度', async () => {
    const jsonResponse = (value: unknown): Response =>
      new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.includes('douyin')) return jsonResponse({ data: { word_list: [{ word: '热词甲', hot_value: 100 }] } });
      return new Response('<div class="c-single-text-ellipsis">热词乙</div>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    };
    const f = makeWorld({ dailySearchLimit: 5 }, fetchImpl);
    const out = String(await tool(f.world, 'netlingo_trending').handler({ limit: 5 }, CALL));
    expect(out).toContain('热词甲');
    expect(out).toContain('热词乙');
    expect(out).toContain('1/5');
    const status = String(await tool(f.world, 'netlingo_status').handler({}, CALL));
    expect(status).toContain('今日联网 1/5');
  });

  it('netlingo_comments 抓楼中楼的一来一回并附弹幕', async () => {
    const jsonResponse = (value: unknown): Response =>
      new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.includes('/search/type')) {
        return jsonResponse({ data: { result: [{ bvid: 'BV1xx', title: '测试视频', play: 12345 }] } });
      }
      if (url.includes('/web-interface/view')) return jsonResponse({ data: { aid: 42, cid: 7 } });
      if (url.includes('/reply/reply')) {
        return jsonResponse({ data: { replies: [{ content: { message: '这谁不怕' }, like: 3 }] } });
      }
      if (url.includes('/x/v2/reply')) {
        return jsonResponse({
          data: { replies: [{ rpid: 9, rcount: 2, content: { message: '你只是怕了' }, like: 88 }] },
        });
      }
      if (url.includes('comment.bilibili.com')) {
        return new Response('<i><d p="1">属于是了</d></i>', {
          status: 200,
          headers: { 'content-type': 'text/xml' },
        });
      }
      return new Response('no', { status: 404 });
    };
    const f = makeWorld({}, fetchImpl);
    const out = String(
      await tool(f.world, 'netlingo_comments').handler({ topic: '测试', save: true }, CALL),
    );
    expect(out).toContain('你只是怕了');
    expect(out).toContain('这谁不怕');
    expect(out).toContain('属于是了');
    expect(out).toContain('播放 1.2 万');
    expect(out).toContain('已存 1 组对话对');
  });

  it('记下并翻出对话对', async () => {
    const f = makeWorld();
    const captured = String(
      await tool(f.world, 'netlingo_capture').handler(
        { a: '你只是怕了', b: '这谁不怕', topic: '打球', note: '反问顶回去' },
        CALL,
      ),
    );
    expect(captured).toContain('已记下');
    expect(captured).toContain('1 组');

    const list = String(await tool(f.world, 'netlingo_exchanges').handler({ query: '怕' }, CALL));
    expect(list).toContain('你只是怕了');
    expect(list).toContain('这谁不怕');
    expect(list).toContain('打球');
  });

  it('同一组对话对不重复累加', async () => {
    const f = makeWorld();
    const capture = tool(f.world, 'netlingo_capture');
    await capture.handler({ a: '你只是怕了', b: '这谁不怕' }, CALL);
    const again = String(await capture.handler({ a: ' 你只是怕了 ', b: ' 这谁不怕' }, CALL));
    expect(again).toContain('已更新');
    expect(again).toContain('1 组');
  });

  it('长期库为空时 exchanges 给出怎么开始', async () => {
    const f = makeWorld();
    const out = String(await tool(f.world, 'netlingo_exchanges').handler({}, CALL));
    expect(out).toContain('还没有对话对');
  });

  it('netlingo_pick 能取到对话对', async () => {
    const f = makeWorld();
    await tool(f.world, 'netlingo_capture').handler({ a: '你只是怕了', b: '这谁不怕' }, CALL);
    const picked = String(await tool(f.world, 'netlingo_pick').handler({}, CALL));
    expect(picked).toContain('你只是怕了');
  });

  it('数据页签列出两个存储项与实时规模', async () => {
    const f = makeWorld();
    await tool(f.world, 'netlingo_learn').handler({ term: 'yyds', meaning: '永远的神' }, CALL);
    await tool(f.world, 'netlingo_capture').handler({ a: '你只是怕了', b: '这谁不怕' }, CALL);
    const parts = f.world.webUi().storage ?? [];
    expect(parts).toHaveLength(2);
    expect(parts[0].key).toBe('netlingo-library');
    expect(parts[0].label).toBe('词条与梗图');
    expect(parts[0].stat()).toContain('词条 1 条');
    expect(parts[0].location).toContain('netlingo-library.json');
    expect(parts[1].key).toBe('netlingo-exchanges');
    expect(parts[1].stat()).toContain('对话对 1 组');
  });

  it('清空对话对不动词条,清空词条不动对话对', async () => {
    const f = makeWorld();
    await tool(f.world, 'netlingo_learn').handler({ term: 'yyds', meaning: '永远的神' }, CALL);
    await tool(f.world, 'netlingo_capture').handler({ a: '你只是怕了', b: '这谁不怕' }, CALL);
    const parts = f.world.webUi().storage ?? [];
    const library = parts[0];
    const exchanges = parts[1];

    await exchanges.clear();
    expect(exchanges.stat()).toContain('0 组');
    expect(library.stat()).toContain('词条 1 条');

    await library.clear();
    expect(library.stat()).toContain('词条 0 条');
    expect(exchanges.stat()).toContain('0 组');
  });

  it('命中原话时给出可以接的下一句', async () => {
    const f = makeWorld();
    await tool(f.world, 'netlingo_capture').handler(
      { a: '你只是怕了', b: '这谁不怕', note: '反问顶回去' },
      CALL,
    );
    const out = String(await tool(f.world, 'netlingo_match').handler({ text: '你只是怕了吧' }, CALL));
    expect(out).toContain('这谁不怕');
    expect(out).toContain('反问顶回去');
    expect(out).toContain('原话命中');
  });

  it('命中词条时说明可以顺着再用', async () => {
    const f = makeWorld();
    await tool(f.world, 'netlingo_learn').handler(
      { term: '有活', meaning: '夸内容有意思', example: '这个是真有活' },
      CALL,
    );
    const out = String(await tool(f.world, 'netlingo_match').handler({ text: '这个视频真有活' }, CALL));
    expect(out).toContain('有活');
    expect(out).toContain('不必刻意回避');
  });

  it('没命中时如实说,不乱给', async () => {
    const f = makeWorld();
    const out = String(await tool(f.world, 'netlingo_match').handler({ text: '今天天气不错' }, CALL));
    expect(out).toContain('没有和');
  });

  it('从事件库读聊天记录并配对入库', async () => {
    const f = makeWorld();
    f.host.store = {
      ...f.host.store,
      range: () => [
        {
          cursor: 1,
          type: 'qq.forward',
          ts: '2026-10-23T05:00:00+08:00',
          source: 'qqbot',
          origin: 'external' as const,
          text: '[系统] #1 引用的转发消息展开如下：\n甲(1): 你只是怕了\n乙(2): 这谁不怕\n甲(1): 试试就试试',
        },
      ],
    } as unknown as typeof f.host.store;
    await f.world.start(f.host);

    const out = String(await tool(f.world, 'netlingo_import_chat').handler({}, CALL));
    expect(out).toContain('存进 2 组');
    expect(out).toContain('这谁不怕');

    const list = String(await tool(f.world, 'netlingo_exchanges').handler({}, CALL));
    expect(list).toContain('你只是怕了');
    expect(list).toContain('这谁不怕');
    await f.world.stop();
  });

  it('事件库里没有聊天记录时说清怎么试', async () => {
    const f = makeWorld();
    await f.world.start(f.host);
    const out = String(await tool(f.world, 'netlingo_import_chat').handler({}, CALL));
    expect(out).toContain('没有');
    await f.world.stop();
  });

  it('给表情打标签后能按气氛查到', async () => {
    const f = makeWorld();
    const labeled = String(
      await tool(f.world, 'netlingo_label_sticker').handler(
        { file: 'sticker-a.gif', mood: '尴尬', when: '别人说了句冷笑话' },
        CALL,
      ),
    );
    expect(labeled).toContain('已记下');

    const out = String(await tool(f.world, 'netlingo_sticker_for').handler({ mood: '尴尬' }, CALL));
    expect(out).toContain('[表情包:sticker-a.gif]');
    expect(out).toContain('冷笑话');
  });

  it('同义词算一组:标「无语」能按「尴尬」查到', async () => {
    const f = makeWorld();
    await tool(f.world, 'netlingo_label_sticker').handler({ file: 'sticker-b.png', mood: '无语' }, CALL);
    const out = String(await tool(f.world, 'netlingo_sticker_for').handler({ mood: '尴尬' }, CALL));
    expect(out).toContain('sticker-b.png');
  });

  it('没有标签也没有索引时说清怎么开始', async () => {
    const f = makeWorld();
    const out = String(await tool(f.world, 'netlingo_sticker_for').handler({ mood: '庆祝' }, CALL));
    expect(out).toContain('还没有标过');
    expect(out).toContain('表情索引文件');
  });

  it('配了表情索引时列出候选文件名', async () => {
    const indexPath = join(scratchDir, 'sticker-index.json');
    writeFileSync(
      indexPath,
      JSON.stringify({ a: { file: 'sticker-c.gif' }, b: { file: 'sticker-d.png' } }),
      'utf8',
    );
    const f = makeWorld({ stickerIndex: indexPath });
    const out = String(await tool(f.world, 'netlingo_sticker_for').handler({ mood: '庆祝' }, CALL));
    expect(out).toContain('sticker-c.gif');
    expect(out).toContain('现有 2 张');
  });

  it('记下接龙后能判断接得对不对', async () => {
    const f = makeWorld();
    await tool(f.world, 'netlingo_learn').handler(
      { term: '康神开播了', meaning: '电竞梗', chains: ['zdjd（真的假的）', 'wkzkbl'] },
      CALL,
    );
    const list = String(await tool(f.world, 'netlingo_chain').handler({ term: '康神开播了' }, CALL));
    expect(list).toContain('zdjd');

    const good = String(
      await tool(f.world, 'netlingo_chain').handler({ term: '康神开播了', candidate: 'zdjd' }, CALL),
    );
    expect(good).toContain('接得对');

    const bad = String(
      await tool(f.world, 'netlingo_chain').handler({ term: '康神开播了', candidate: '随便接一句' }, CALL),
    );
    expect(bad).toContain('不在库里');
  });

  it('查没记过的梗时直说,不编', async () => {
    const f = makeWorld();
    const out = String(await tool(f.world, 'netlingo_chain').handler({ term: '不存在的梗' }, CALL));
    expect(out).toContain('没有记过');
  });

  it('别名也能查到接龙', async () => {
    const f = makeWorld();
    await tool(f.world, 'netlingo_learn').handler(
      { term: '康神开播了', meaning: '电竞梗', chains: ['zdjd'] },
      CALL,
    );
    const copy = f.world['library'];
    void copy;
    const lib = JSON.parse(readFileSync(join(f.dataDir, 'netlingo-library.json'), 'utf8'));
    lib.terms[0].aliases = ['kskbl'];
    writeFileSync(join(f.dataDir, 'netlingo-library.json'), JSON.stringify(lib), 'utf8');
    const out = String(await tool(f.world, 'netlingo_chain').handler({ term: 'kskbl' }, CALL));
    expect(out).toContain('康神开播了');
  });

  it('面板 list 返回词条与计数', async () => {
    const f = makeWorld();
    await tool(f.world, 'netlingo_learn').handler(
      { term: 'yyds', meaning: '永远的神', chains: ['YYDS'] },
      CALL,
    );
    const invoke = f.world.webUi().invoke;
    expect(invoke).toBeTruthy();
    const payload = (await invoke!('library', 'list', [])) as {
      counts: { terms: number };
      terms: Array<{ term: string; chains: string[] }>;
    };
    expect(payload.counts.terms).toBe(1);
    expect(payload.terms[0].term).toBe('yyds');
    expect(payload.terms[0].chains).toEqual(['YYDS']);
  });

  it('状态回执写清开关、用量与库存', async () => {
    const f = makeWorld();
    await tool(f.world, 'netlingo_learn').handler({ term: 'yyds', meaning: '永远的神' }, CALL);
    const status = String(await tool(f.world, 'netlingo_status').handler({}, CALL));
    expect(status).toContain('网络语言能力:开');
    expect(status).toContain('词条 1 条');
  });

  it('环境提示词变量在关闭后说明不要联网', async () => {
    const f = makeWorld({ netLanguageEnabled: false });
    const vars = await f.world.envPromptVars();
    expect(vars['netlingo.status']).toContain('已关闭');
  });
});
