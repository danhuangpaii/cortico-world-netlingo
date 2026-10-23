## 0.3.3

- 新增 `netlingo_label_sticker` 与 `netlingo_sticker_for`:给表情包记下「适合什么气氛」,之后按当前气氛查到该发的 `[表情包:文件名]`。同义词会归一(尴尬/无语/冷场算一组)。
- 新增「表情时机」配置组:`stickerIndex` 填 QQ 的 sticker-index.json 路径后,没标注时能列出候选文件名。
- 环境提示词补「什么时候发什么表情」:命中再发、没命中先别硬发、正事与吵架时别发。

## 0.3.2

- 简介补一句:也可以当作一个互联网接口使用,查网络用语、热榜与评论区。

## 0.3.1

- 新增 `netlingo_import_chat`:从事件库读群里最近分享的聊天记录(QQ World 展开的 `qq.forward`),把不同人的相邻发言配成对话对存进长期库;只读事件库,不联网、不扣额度。
- 不做 GIF/图片识别:那属于 QQ World 的 vision,本包只处理文字形式的聊天记录。

## 0.2.1

- 加中文关键词(网络语言、网络用语、梗、梗图、群聊)与中文显示名,在 npm 与扩展市场里用中文搜得到。
- `cortico.locales` 提供中英显示名与简介。

## 0.2.0

- 新增 `netlingo_match`:拿群聊原话查库,命中对话对就给出可以接的下一句,命中词条就说明群友用的词你记过、可以顺着再用;本地查询,不联网不扣额度。
- 新增长期对话库:`netlingo_capture` 记群里的一来一回,`netlingo_comments` 加 `save: true` 把 B 站楼中楼成对存入,`netlingo_exchanges` 翻出来用;`netlingo_pick` 也会取对话对。
- World 页「数据」页签列出库的位置与实时规模:词条与梗图、对话对各一项,可分别清除。
- 评论区改成「楼 + 楼中楼」结构并附弹幕短句,用来看网友一来一回怎么接话。
- 加联网状态灯;提示词按「水群接话」重写,并内置搜索源改为 360 → 搜狗 → Bing RSS → DuckDuckGo。

## 0.1.0

首个版本。

- 联网查词(`netlingo_search`)、本地记词(`netlingo_learn` / `netlingo_recall`);每日联网次数可设,查词与抓图各算一次。内置搜索先问 Bing,不通再退回 DuckDuckGo;也可换成自己的端点。
- 从图片地址或搜索结果页的 `og:image` 收集梗图(`netlingo_collect_meme`),可复制到 QQ 表情包目录,用 `[表情包:文件名]` 发送。
- 静默满设定时长后推 `netlingo.opportunity`,附一条随机素材;说不说由 bot 判断。本地库还空着时每天推一次收集提醒。
- 网络语言能力可开关,配置与 `netlingo_switch` 两个入口,都立即生效。
- 网络语言能力可开关,配置与 `netlingo_switch` 两个入口,都立即生效。
