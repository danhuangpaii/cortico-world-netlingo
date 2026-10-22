import { describe, it, expect } from 'vitest';
import {
  fetchBiliThread,
  fetchDanmaku,
  fetchTrending,
  parseBaiduHot,
  parseBiliReplies,
  parseBiliSearch,
  parseDanmaku,
  parseDouyinHot,
  searchBiliVideos,
} from '../src/trending.ts';

const json = (value: unknown): Response =>
  new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });

const html = (body: string): Response =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });

describe('热榜解析', () => {
  it('从抖音热榜取词与热度', () => {
    const items = parseDouyinHot({
      data: { word_list: [{ word: '红军长征胜利90周年纪念日', hot_value: 11105892 }, { word: '乡村里的拼豆店' }] },
    });
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ title: '红军长征胜利90周年纪念日', hot: 11105892, source: 'douyin' });
    expect(items[1].hot).toBeUndefined();
  });

  it('抖音结构不符时返回空数组', () => {
    expect(parseDouyinHot({})).toEqual([]);
    expect(parseDouyinHot(null)).toEqual([]);
  });

  it('从百度热搜页取标题并去重', () => {
    const page =
      '<div class="c-single-text-ellipsis">让总书记驻足的长征故事</div>' +
      '<div class="c-single-text-ellipsis">让总书记驻足的长征故事</div>' +
      '<div class="c-single-text-ellipsis">全球70%网站都危险了</div>';
    const items = parseBaiduHot(page);
    expect(items).toHaveLength(2);
    expect(items[0].source).toBe('baidu');
  });

  it('合并两个来源时按热度降序', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.includes('douyin')) {
        return json({ data: { word_list: [{ word: '低热度', hot_value: 5 }, { word: '高热度', hot_value: 999 }] } });
      }
      return html('<div class="c-single-text-ellipsis">百度热词标题</div>');
    };
    const result = await fetchTrending(fetchImpl, 10);
    expect(result.ok).toBe(true);
    expect(result.value?.map((item) => item.title)).toEqual(['高热度', '低热度', '百度热词标题']);
  });

  it('两个来源都失败时报告原因', async () => {
    const fetchImpl: typeof fetch = async () => new Response('no', { status: 403 });
    const result = await fetchTrending(fetchImpl, 10);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('抖音热榜');
    expect(result.error).toContain('百度热搜');
  });
});

describe('B 站', () => {
  it('从搜索响应取视频并把高亮标签去掉', () => {
    const videos = parseBiliSearch({
      data: { result: [{ bvid: 'BV1xx411c7mD', title: '<em>尊嘟假嘟</em>是什么梗', play: 12345 }] },
    });
    expect(videos).toHaveLength(1);
    expect(videos[0].title).toBe('尊嘟假嘟是什么梗');
    expect(videos[0].url).toBe('https://www.bilibili.com/video/BV1xx411c7mD');
  });

  it('搜索按播放量降序', async () => {
    const fetchImpl: typeof fetch = async () =>
      json({
        data: {
          result: [
            { bvid: 'BV1', title: '低播放', play: 10 },
            { bvid: 'BV2', title: '高播放', play: 90000 },
          ],
        },
      });
    const result = await searchBiliVideos('测试', fetchImpl, 1);
    expect(result.value?.[0].bvid).toBe('BV2');
  });

  it('评论按点赞降序,置顶也算,重复内容去掉', () => {
    const comments = parseBiliReplies({
      data: {
        top_replies: [{ content: { message: '置顶评论' }, like: 500, member: { uname: 'up' } }],
        replies: [
          { content: { message: '普通评论' }, like: 20, member: { uname: 'a' } },
          { content: { message: '普通评论' }, like: 20, member: { uname: 'a' } },
          { content: { message: '高赞评论' }, like: 300, member: { uname: 'b' } },
        ],
      },
    });
    expect(comments).toHaveLength(3);
    expect(comments.map((c) => c.text)).toContain('置顶评论');
  });

  it('先取主楼,再取每楼的楼中楼', async () => {
    const seen: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : String(input);
      seen.push(url);
      if (url.includes('/x/web-interface/view')) return json({ data: { aid: 170001, cid: 999 } });
      if (url.includes('/x/v2/reply/reply')) {
        return json({ data: { replies: [{ content: { message: '这谁不怕' }, like: 5 }] } });
      }
      if (url.includes('/x/v2/reply')) {
        return json({
          data: { replies: [{ rpid: 1, rcount: 3, content: { message: '你只是怕了' }, like: 88 }] },
        });
      }
      return new Response('no', { status: 404 });
    };
    const result = await fetchBiliThread('BV1xx411c7mD', fetchImpl, 3, 20);
    expect(result.ok).toBe(true);
    expect(result.value?.threads[0].root.text).toBe('你只是怕了');
    expect(result.value?.threads[0].replies[0].text).toBe('这谁不怕');
    expect(result.value?.cid).toBe(999);
    expect(seen.some((url) => url.includes('root=1'))).toBe(true);
  });

  it('没有回复的主楼不去请求楼中楼', async () => {
    const seen: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : String(input);
      seen.push(url);
      if (url.includes('/x/web-interface/view')) return json({ data: { aid: 1, cid: 2 } });
      return json({ data: { replies: [{ rpid: 5, rcount: 0, content: { message: '主楼' } }] } });
    };
    const result = await fetchBiliThread('BV1', fetchImpl, 3, 20);
    expect(result.ok).toBe(true);
    expect(seen.some((url) => url.includes('/reply/reply'))).toBe(false);
  });

  it('拿不到 aid 时如实报错', async () => {
    const fetchImpl: typeof fetch = async () => json({ code: -404, message: '啥都木有' });
    const result = await fetchBiliThread('BVbad', fetchImpl, 3, 20);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('aid');
  });

  it('解析弹幕短句并去重,丢掉过短的', () => {
    const xml =
      '<i><d p="1">这谁不怕</d><d p="2">这谁不怕</d><d p="3">你只是怕了</d><d p="4">x</d><d p="5"></d></i>';
    expect(parseDanmaku(xml, 10)).toEqual(['这谁不怕', '你只是怕了']);
  });

  it('取弹幕', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.includes('comment.bilibili.com')) {
        return new Response('<i><d p="1">属于是了</d></i>', {
          status: 200,
          headers: { 'content-type': 'text/xml' },
        });
      }
      return new Response('no', { status: 404 });
    };
    const result = await fetchDanmaku(123, fetchImpl, 5);
    expect(result.ok).toBe(true);
    expect(result.value).toEqual(['属于是了']);
  });
});
