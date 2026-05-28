# 多人协作地图编辑器

基于 WebSocket 的多人实时协作游戏地图编辑器，支持 9000×9000 大地图。

## 快速开始

```bash
cd /tmp/collab-editor
npm install
npm start
```

服务器启动后访问：`http://localhost:3456`

## 功能

### 地图编辑
- 空间站、建筑（10×10 / 20×20）、计划圈（10种类型）、委派圈、曲率圈
- 标记（6种）、路线（曲速/普通）、文字标注
- 缩放、平移、拖拽选区、移动模式
- 触控完整支持（双指缩放、长按右键、拖拽选区）

### 多人协作
- 房间系统：6位房间码，支持密码保护
- 角色系统：Admin（最高权限）/ Member / Viewer
- Admin 可管理成员角色和操作权限
- 实时同步：放置/编辑/删除/移动 操作即时同步
- 数据自动保存（30秒间隔）

## 使用流程

1. 打开 `http://localhost:3456`
2. 创建新房间（设置名称、密码、权限）或输入房间码加入
3. 输入昵称加入房间
4. 开始协作编辑地图

## 数据存储

- 房间数据保存在 `data/` 目录，每个房间一个 JSON 文件
- 30秒自动保存，服务器关闭时全量保存
- 空房间1分钟后自动从内存清理（数据保留在磁盘）

## 角色权限

| 操作 | Admin | Member | Viewer |
|------|-------|--------|--------|
| 放置物品 | ✅ | 可配置 | ❌ |
| 编辑物品 | ✅ | 可配置 | ❌ |
| 删除物品 | ✅ | 可配置 | ❌ |
| 移动物品 | ✅ | ✅ | ❌ |
| 清除全部 | ✅ | ❌ | ❌ |
| 导入数据 | ✅ | ❌ | ❌ |
| 管理成员 | ✅ | ❌ | ❌ |
| 设置权限 | ✅ | ❌ | ❌ |

## Docker 部署（推荐）

### 直接拉镜像

```bash
docker run -d \
  --name map-editor \
  -p 3456:3456 \
  -v $(pwd)/data:/app/data \
  --restart unless-stopped \
  ghcr.io/bemlyyyyyyyyyyyy/collab-map-editor:latest
```

### docker-compose

```yaml
# docker-compose.yml
services:
  map-editor:
    image: ghcr.io/bemlyyyyyyyyyyyy/collab-map-editor:latest
    ports:
      - "3456:3456"
    volumes:
      - ./data:/app/data
    restart: unless-stopped
```

```bash
docker compose up -d
```

### 自己构建

```bash
git clone https://github.com/bemlyyyyyyyyyyyy/collab-map-editor.git
cd collab-map-editor
docker build -t collab-map-editor .
docker run -d -p 3456:3456 -v $(pwd)/data:/app/data collab-map-editor
```

## 传统部署

在同一局域网内，其他设备可通过 `http://服务器IP:3456` 访问。
如需公网访问，建议使用 Nginx 反向代理 + TLS。

```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;
    
    location / {
        proxy_pass http://localhost:3456;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```
