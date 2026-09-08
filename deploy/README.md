# Jellyfin Web Custom & Deployment Architecture

本文档记录了基于 `FEI352/jellyfin-web` 的前端定制开发与生产部署架构。

## 1. 架构概览

- **访问入口**：`https://tv.fja.su`（Nginx HTTPS + HTTP/2 + WebSocket 代理）
- **媒体源挂载**：Alist WebDAV（通过 `rclone-alist.service` 挂载至 `/mnt/alist`，Docker 容器内以 `:rslave` 模式映射至 `/media`）
- **前端定制**：
  - **「最近观看」增强**：通过 `src/components/homesections/sections/resume.ts` 与 `scripts/recent.js` 实现播放断点续播与历史记录双重保留。
  - **中文本地化**：将首页生硬的 `HeaderContinueWatching`（继续观看）翻译统一优化为符合使用习惯的「最近观看」。
  - **假面骑士与日漫元数据注入**：`scripts/inject_kr_metadata.py`，解决 Alist/网盘非标文件名的刮削与封面匹配问题。

## 2. 目录结构

```text
deploy/
├── docker/
│   └── docker-run.sh         # Docker 运行指令（host 网络模式 + rslave 卷挂载）
├── nginx/
│   └── tv.fja.su.conf        # Nginx 反向代理配置（SSL, 禁用流式缓冲, 静态脚本代理）
├── systemd/
│   └── rclone-alist.service  # Alist 自动挂载服务与黑名单排除规则
└── scripts/
    ├── recent.js             # 前端运行时注入的「最近观看」与断点续播脚本
    └── inject_kr_metadata.py # TMDB/TheTVDB 海报与集数注入脚本
```

## 3. 部署与同步

```bash
# 重载 Nginx 反向代理
nginx -t && nginx -s reload

# 重启 Alist 挂载服务
systemctl restart rclone-alist.service

# 重启 Jellyfin 容器以刷新内存元数据缓存
docker restart jellyfin
```
