# vendor（第三方前端库，本地文件，不联网）

小人窗接 Live2D 用的三个库，都是随应用一起分发的本地文件：

| 文件 | 来源 | 版本 | 许可 |
| --- | --- | --- | --- |
| `pixi.min.js` | [pixi.js](https://github.com/pixijs/pixi.js) | 6.5.10 | MIT |
| `pixi-unsafe-eval.min.js` | `@pixi/unsafe-eval` | 6.5.10 | MIT（不注入 eval，配合 CSP 使用） |
| `pixi-live2d-display.min.js` | [pixi-live2d-display](https://github.com/guansss/pixi-live2d-display) | 0.4.0（cubism4 构建） | MIT |
| `live2dcubismcore.min.js` | [Live2D Cubism SDK for Web](https://www.live2d.com/sdk/cubism/) | 官方 Core | Live2D 专有许可（随应用分发时需遵守 Live2D 的 SDK 条款） |

## 为什么带 `pixi-unsafe-eval`

应用的 CSP 不允许 `unsafe-eval`。Pixi 默认用 `new Function` 生成着色器，
这个补丁把它换成不依赖 eval 的实现；必须在 `pixi.min.js` 之后、创建 `PIXI.Application` 之前加载。

## 模型放哪

Live2D 模型不进这个目录，也不进仓库：放在角色自己的数据目录下，例如

```
data/characters/<角色 id>/live2d/Hiyori/Hiyori.model3.json
```

形象包里写 `"live2d": "live2d/Hiyori/Hiyori.model3.json"` 就会用模型渲染；读不到自动退回静态立绘。
