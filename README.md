ArkPets-Web
===============

这是 [fuyufjh/ArkPets-Web](https://github.com/fuyufjh/ArkPets-Web) 的 fork

和原版的区别：

- 适配 [Ark-Models](https://github.com/isHarryh/Ark-Models) 现在的预乘 Alpha 贴图
- 会播放 `Special` 动作，走动更多，睡觉更少
- 支持触屏：点按互动，拖动移动，长按打开菜单
- 菜单跟随网页语言（中文/英文）
- 客户端记住选择的模型和隐藏状态
- 模型文件不放在仓库里，模型列表写在 `models.config.json` 内

## 使用

```bash
npm ci
npm run build
npm run models -- dist
```

把 `dist` 里的 `arkpets.js`、`manifest.json` 和 `models` 放到网站目录，然后在页面里加一行：

```html
<script src="arkpets.js" data-arkpets-manifest="manifest.json" defer></script>
```

---

A fork of ArkPets-Web. It supports the current Ark-Models textures, the `Special` animation, touch screens and a Chinese/English menu. Models are not stored in this repository: list them in `models.config.json` and download them with `npm run models -- dist`.

---

以下是原版说明 / Original README:

用 Spine-ts (WebGL) 实现的明日方舟桌宠。暂时只能嵌入到网页中使用，如果你拥有个人主页的话。

An Arknights Shimeji implemented using Spine-ts (WebGL). Currently, it can only be embedded in web pages, if you have a personal homepage.

启发自[ArkPets](https://github.com/isHarryh/Ark-Pets)(Windows 平台)。素材版权属于[鹰角网络](https://www.hypergryph.com/)。

Inspired by ArkPets (Windows-only). The material copyrights belong to [Hypergryph](https://www.hypergryph.com/).

**浏览器插件请移步 [ArkPets-Chrome](https://github.com/fuyufjh/ArkPets-Chrome)（[官网](https://arkpets.ericfu.me/)）。**

**For browser extension, please check [ArkPets-Chrome](https://github.com/fuyufjh/ArkPets-Chrome) ([Website](https://arkpets.ericfu.me/)).**
