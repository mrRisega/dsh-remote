# dsh-remote · 开源 SEO 与热度提升清单

> 目标:让 dsh-remote 在 DeepSeek Harness 插件生态中获得更多自然流量。
> 已自动完成的部分标注 ✅,需你手动操作的部分标注 ⬜。

## 1. GitHub Topics(最关键,决定能否被生态搜索到)

DeepSeek Harness 社区官方推荐:**给插件仓库打 `dsh-plugin` topic** 即可被搜索。
已确认生态中的同类项目(xgone/dsh-remote 等)都打了此标签。

⬜ **操作**:打开 https://github.com/mrgaoang/dsh-remote → 右侧 **About** →
**齿轮图标** → Topics 填入(每个回车确认):

```
dsh-plugin
deepseek-harness
dsh
cordis
remote-access
mobile
mobile-web
remote-control
reverse-proxy
self-hosted
pwa
deepseek
```

> 打上 `dsh-plugin` 后,仓库会出现在
> [github.com/topics/dsh-plugin](https://github.com/topics/dsh-plugin) 列表,
> 并被多个 awesome 列表自动抓取(0xsline/awesome-deepseek-harness 等)。

## 2. 提交到 awesome 列表(收录后可获得定向流量)

### 2a. Anil-matcha/awesome-dsh-plugin(已准备好 PR)

已在本地完成修改(新增 **Remote Access & Mobile** 分类收录 dsh-remote)。

⬜ **操作**:
1. Fork:打开 https://github.com/Anil-matcha/awesome-dsh-plugin → **Fork**
2. 运行辅助脚本:
   ```bash
   bash /tmp/awesome-pr-helper.sh
   ```
3. 浏览器打开脚本输出的链接,确认 compare 目标为
   `Anil-matcha/awesome-dsh-plugin:main`,点 **Create pull request**
4. 标题:`Add dsh-remote to new Remote Access & Mobile category`

### 2b. 0xsline/awesome-deepseek-harness(自动抓取 topic)

该列表从 `dsh-plugin` topic 自动收录,打上 topic 后即可能被纳入
**Browser & Remote** 分类(该分类已有两个 dsh-remote 同名项目,我们是
第三个 —— 定位差异化:loopback 伪装实现特权方法全覆盖)。

### 2c. 其他列表(可选)

- `web-casa/Awesome-DeepSeek-Harness-Plugins`(主要收 Cordis 插件,格式不符,可跳过)
- `libukai/awesome-deepseek-harness`、`Dominic789654/awesome-deepseek-harness`(看情况)

## 3. 差异化定位(应对同名竞争)

生态中已有 **xgone/dsh-remote**(7⭐,Cordis 插件:账号/MFA/角色)与
**flymysql/dsh-remote**(多机 SSH 工作区)。我们的核心差异点:

| 维度 | 我们的 dsh-remote | xgone/dsh-remote(插件式) |
|---|---|---|
| 特权方法(settings/credentials) | ✅ **loopback 伪装全覆盖** | ❌ 受 dsh web 信任围栏限制 |
| 形式 | 独立网关(零侵入) | Cordis 插件 |
| 部署 | LAN 直连 / 公网反代 | 需装进 dsh web |

建议在 README 增加一段"与同类项目对比"以突出优势(可选)。

## 4. 已完成 ✅

- README:徽章(DeepSeek Harness / dsh-plugin / License / Node / Platform)、
  关键词行、生态与发现章节、界面截图(你已加)
- package.json:keywords 扩充(dsh-plugin、cordis、mobile-web、pwa、self-hosted 等)
- awesome-dsh-plugin 的 PR 分支已本地准备好

## 5. 后续可做(提高留存与转发)

- [ ] 添加 social preview 图(仓库 → Settings → Social preview,1200×600 PNG)
- [ ] 写一篇使用教程发到社区(掘金/知乎/Discord),文末附仓库链接
- [ ] 在 README 加"Star 历史"徽章(shields.io/stars 已有)
- [ ] 发布 Release 并打 tag(便于用户引用稳定版本)
