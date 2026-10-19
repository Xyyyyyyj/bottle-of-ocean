# Bottle of Ocean

在 16×16 灯板上点色、改色、熄灭。颜色来自 Pindo MARD 全色板 377 色。

这是纯静态网页，推到 GitHub 的 `main` 后会由 Actions 发布成 GitHub Pages。

打开地址：

https://Xyyyyyyj.github.io/bottle-of-ocean/

本地预览：

```bash
node serve.mjs
```

然后打开 http://127.0.0.1:8787/

图案会保存在你自己的浏览器里，换设备不会同步。

## 发布到 github.io

仓库根目录就是这个 `web/` 文件夹。也可以双击 `发布到 GitHub.cmd`。

第一次手动发布：

```bash
cd web
gh auth login
gh repo create bottle-of-ocean --public --source=. --remote=origin --push
```

然后在 GitHub 仓库 **Settings → Pages** 里把 Source 设为 **GitHub Actions**。之后每次推 `main` 都会更新网页。
