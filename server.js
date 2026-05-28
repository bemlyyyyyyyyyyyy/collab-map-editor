const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = 3456;
const DATA_DIR = path.join(__dirname, 'data');
const SAVE_INTERVAL = 30000;
const MAX_USERNAME_LEN = 30;
const MAX_ROOM_NAME_LEN = 50;
const MAX_BODY_SIZE = 1024 * 1024; // 1MB HTTP body limit
const MAX_WS_MSG_SIZE = 512 * 1024; // 512KB WebSocket message limit
const RATE_LIMIT_WINDOW = 1000; // 1 second window
const MAX_MSGS_PER_WINDOW = 30; // max 30 messages/second per connection
const MAX_DATA_ITEMS = 100000; // max items per room to prevent memory bomb
const EMPTY_ROOM_CLEANUP = 5 * 60 * 1000; // 5 min cleanup

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const rooms = new Map();
const sockets = new Map();

// ─── Helpers ───

function generateRoomId() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let id = '';
    for (let i = 0; i < 6; i++) id += chars[crypto.randomInt(chars.length)];
    if (rooms.has(id)) return generateRoomId();
    return id;
}

function generateUserId() {
    return crypto.randomBytes(16).toString('hex');
}

function makeRoomData() {
    return { plans: [], routes: [], markers: [], texts: [] };
}

function sanitize(str, maxLen = MAX_USERNAME_LEN) {
    if (typeof str !== 'string') return '';
    return str.replace(/[<>"']/g, '').substring(0, maxLen).trim();
}

function loadRoomData(roomId) {
    if (!/^[A-Z0-9]{6}$/.test(roomId)) return makeRoomData();
    const file = path.join(DATA_DIR, `${roomId}.json`);
    try {
        if (fs.existsSync(file)) {
            return JSON.parse(fs.readFileSync(file, 'utf-8'));
        }
    } catch (e) {
        console.error(`Error loading room ${roomId}:`, e.message);
    }
    return makeRoomData();
}

function saveRoomData(roomId) {
    const room = rooms.get(roomId);
    if (!room) return;
    const file = path.join(DATA_DIR, `${roomId}.json`);
    try {
        fs.writeFileSync(file, JSON.stringify(room.data, null, 2), 'utf-8');
    } catch (e) {
        console.error(`Error saving room ${roomId}:`, e.message);
    }
}

setInterval(() => {
    for (const [roomId, room] of rooms) {
        if (room.dirty) { saveRoomData(roomId); room.dirty = false; }
    }
}, SAVE_INTERVAL);

function markDirty(roomId) {
    const room = rooms.get(roomId);
    if (room) room.dirty = true;
}

// ─── Input Validation ───

function validatePlan(p) {
    if (!p || typeof p !== 'object') return false;
    if (typeof p.x !== 'number' || typeof p.y !== 'number') return false;
    if (p.x < -100 || p.x > 10000 || p.y < -100 || p.y > 10000) return false;
    if (p.width && (p.width < 1 || p.width > 1000)) return false;
    if (p.height && (p.height < 1 || p.height > 1000)) return false;
    if (p.name && typeof p.name === 'string' && p.name.length > 100) return false;
    if (p.note && typeof p.note === 'string' && p.note.length > 500) return false;
    return true;
}

function validateRoute(r) {
    if (!r || typeof r !== 'object') return false;
    if (!r.start || !r.end) return false;
    if (typeof r.start.x !== 'number' || typeof r.start.y !== 'number') return false;
    if (typeof r.end.x !== 'number' || typeof r.end.y !== 'number') return false;
    if (r.start.x < -100 || r.start.x > 10000 || r.start.y < -100 || r.start.y > 10000) return false;
    if (r.end.x < -100 || r.end.x > 10000 || r.end.y < -100 || r.end.y > 10000) return false;
    return true;
}

function validateMarker(m) {
    if (!m || typeof m !== 'object') return false;
    if (typeof m.x !== 'number' || typeof m.y !== 'number') return false;
    if (m.x < -100 || m.x > 10000 || m.y < -100 || m.y > 10000) return false;
    return true;
}

function validateText(t) {
    if (!t || typeof t !== 'object') return false;
    if (typeof t.x !== 'number' || typeof t.y !== 'number') return false;
    if (t.x < -100 || t.x > 10000 || t.y < -100 || t.y > 10000) return false;
    if (t.content && typeof t.content === 'string' && t.content.length > 200) return false;
    return true;
}

function checkItemLimit(room) {
    const total = room.data.plans.length + room.data.routes.length +
                  room.data.markers.length + room.data.texts.length;
    return total < MAX_DATA_ITEMS;
}

// ─── Rate Limiting ───

function createRateLimiter() {
    const buckets = new Map();
    return (key) => {
        const now = Date.now();
        const bucket = buckets.get(key);
        if (!bucket || now - bucket.start > RATE_LIMIT_WINDOW) {
            buckets.set(key, { start: now, count: 1 });
            return true;
        }
        bucket.count++;
        return bucket.count <= MAX_MSGS_PER_WINDOW;
    };
}
const rateLimiter = createRateLimiter();

// ─── HTTP Server ───

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
};

const ALLOWED_STATIC_DIRS = ['collab'];

const server = http.createServer((req, res) => {
    // POST /api/rooms - 创建房间
    if (req.method === 'POST' && req.url === '/api/rooms') {
        let body = '';
        let size = 0;
        req.on('data', chunk => {
            size += chunk.length;
            if (size > MAX_BODY_SIZE) { req.destroy(); return; }
            body += chunk;
        });
        req.on('end', () => {
            try {
                const parsed = JSON.parse(body);
                const name = sanitize(parsed.name || 'Untitled', MAX_ROOM_NAME_LEN);
                const password = typeof parsed.password === 'string' ? parsed.password.substring(0, 50) : '';
                const roomId = generateRoomId();
                rooms.set(roomId, {
                    id: roomId,
                    name,
                    password,
                    creator: null,
                    data: makeRoomData(),
                    users: new Map(),
                    permissions: {
                        memberCanPlace: true,
                        memberCanEdit: true,
                        memberCanDelete: true
                    },
                    dirty: false
                });
                res.writeHead(201, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ roomId }));
            } catch (e) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Invalid request' }));
            }
        });
        return;
    }

    // GET /api/rooms/:roomId - 查询房间
    if (req.method === 'GET' && req.url.startsWith('/api/rooms/')) {
        const roomId = req.url.split('/').pop().substring(0, 6);
        const room = rooms.get(roomId);
        if (!room) {
            res.writeHead(404);
            res.end(JSON.stringify({ error: 'Room not found' }));
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ roomId: room.id, name: room.name, hasPassword: !!room.password, userCount: room.users.size }));
        return;
    }

    // 静态文件 - 只允许 collab/ 目录
    let filePath = req.url;
    if (filePath === '/' || filePath === '/collab/' || filePath === '/collab') {
        filePath = '/collab/index.html';
    }

    // 安全：规范化路径防止目录穿越
    const normalized = path.normalize(filePath).replace(/^(\.\.[\/\\])+/, '');
    const parts = normalized.split(path.sep).filter(Boolean);

    // 只允许 collab/ 目录下的文件
    if (parts[0] !== 'collab') {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    // 只允许 .html .css .js .json .svg .png .jpg .ico
    const ext = path.extname(normalized).toLowerCase();
    if (!['.html', '.css', '.js', '.json', '.svg', '.png', '.jpg', '.ico'].includes(ext)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    const fullPath = path.join(__dirname, normalized);

    // 二次确认：最终路径必须在项目目录内
    if (!fullPath.startsWith(path.resolve(__dirname, 'collab'))) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    const mimeType = MIME_TYPES[ext] || 'application/octet-stream';
    fs.readFile(fullPath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not Found'); return; }
        res.writeHead(200, { 'Content-Type': mimeType });
        res.end(data);
    });
});

// ─── WebSocket Server ───

const wss = new WebSocket.Server({
    server,
    maxPayload: MAX_WS_MSG_SIZE // 限制消息大小
});

function broadcast(roomId, message, excludeUserId = null) {
    const room = rooms.get(roomId);
    if (!room) return;
    const msg = JSON.stringify(message);
    for (const [userId, user] of room.users) {
        if (userId !== excludeUserId && user.ws.readyState === WebSocket.OPEN) {
            user.ws.send(msg);
        }
    }
}

function sendTo(ws, message) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
    }
}

function sendError(ws, message) {
    sendTo(ws, { type: 'error', message });
}

function getRoomUsers(roomId) {
    const room = rooms.get(roomId);
    if (!room) return [];
    const users = [];
    for (const [userId, user] of room.users) {
        users.push({ userId, username: sanitize(user.username), role: user.role });
    }
    return users;
}

function canPlace(socketInfo) {
    if (socketInfo.role === 'viewer') return false;
    if (socketInfo.role === 'admin') return true;
    const room = rooms.get(socketInfo.roomId);
    return room ? room.permissions.memberCanPlace !== false : false;
}

function canEdit(socketInfo) {
    if (socketInfo.role === 'viewer') return false;
    if (socketInfo.role === 'admin') return true;
    const room = rooms.get(socketInfo.roomId);
    return room ? room.permissions.memberCanEdit !== false : false;
}

function canDelete(socketInfo) {
    if (socketInfo.role === 'viewer') return false;
    if (socketInfo.role === 'admin') return true;
    const room = rooms.get(socketInfo.roomId);
    return room ? room.permissions.memberCanDelete !== false : false;
}

// 加入失败计数器（防暴力破解）
const joinFailCounts = new Map();

wss.on('connection', (ws, req) => {
    const socketInfo = { userId: null, username: null, roomId: null, role: null, ws };
    const clientIp = req.socket.remoteAddress || 'unknown';

    ws.on('message', (raw) => {
        // 速率限制
        const limitKey = `${clientIp}:${socketInfo.userId || 'anon'}`;
        if (!rateLimiter(limitKey)) {
            sendError(ws, 'Rate limit exceeded, slow down');
            return;
        }

        let msg;
        try {
            const str = raw.toString();
            if (str.length > MAX_WS_MSG_SIZE) {
                sendError(ws, 'Message too large');
                return;
            }
            msg = JSON.parse(str);
        } catch (e) {
            sendError(ws, 'Invalid message format');
            return;
        }

        if (!msg || typeof msg.type !== 'string') {
            sendError(ws, 'Invalid message');
            return;
        }

        switch (msg.type) {
            case 'join': {
                const { roomId, password, username } = msg;
                if (!roomId || !username) {
                    sendError(ws, 'Missing roomId or username');
                    return;
                }

                // 防暴力破解：10次失败后等30秒
                const failKey = `${clientIp}:${roomId}`;
                const fails = joinFailCounts.get(failKey) || { count: 0, until: 0 };
                if (Date.now() < fails.until) {
                    sendError(ws, 'Too many attempts, wait 30 seconds');
                    return;
                }

                const room = rooms.get(roomId);
                if (!room) {
                    fails.count++; fails.until = fails.count >= 10 ? Date.now() + 30000 : 0;
                    joinFailCounts.set(failKey, fails);
                    sendError(ws, 'Room not found');
                    return;
                }

                if (room.password && room.password !== (password || '')) {
                    fails.count++; fails.until = fails.count >= 10 ? Date.now() + 30000 : 0;
                    joinFailCounts.set(failKey, fails);
                    sendError(ws, 'Wrong password');
                    return;
                }

                // 成功，清除失败计数
                joinFailCounts.delete(failKey);

                // 防重复加入
                if (socketInfo.roomId) {
                    const oldRoom = rooms.get(socketInfo.roomId);
                    if (oldRoom) {
                        oldRoom.users.delete(socketInfo.userId);
                        broadcast(socketInfo.roomId, { type: 'user_left', userId: socketInfo.userId, username: socketInfo.username });
                    }
                }

                const userId = generateUserId();
                let role = 'member';
                if (!room.creator) {
                    role = 'admin';
                    room.creator = userId;
                }

                socketInfo.userId = userId;
                socketInfo.username = sanitize(username);
                socketInfo.roomId = roomId;
                socketInfo.role = role;

                room.users.set(userId, { userId, username: socketInfo.username, role, ws });

                sendTo(ws, {
                    type: 'joined',
                    userId,
                    username: socketInfo.username,
                    room: room.data,
                    users: getRoomUsers(roomId),
                    role,
                    permissions: room.permissions,
                    roomName: room.name
                });

                broadcast(roomId, { type: 'user_joined', userId, username: socketInfo.username, role }, userId);
                break;
            }

            default: {
                if (!socketInfo.roomId) {
                    sendError(ws, 'Not joined a room');
                    return;
                }
                const room = rooms.get(socketInfo.roomId);
                if (!room) {
                    sendError(ws, 'Room not found');
                    return;
                }
                handleAction(msg, socketInfo, room);
            }
        }
    });

    ws.on('close', () => {
        if (socketInfo.roomId) {
            const room = rooms.get(socketInfo.roomId);
            if (room) {
                room.users.delete(socketInfo.userId);
                broadcast(socketInfo.roomId, {
                    type: 'user_left',
                    userId: socketInfo.userId,
                    username: socketInfo.username
                });
                if (room.users.size === 0) {
                    saveRoomData(socketInfo.roomId);
                    setTimeout(() => {
                        const r = rooms.get(socketInfo.roomId);
                        if (r && r.users.size === 0) {
                            rooms.delete(socketInfo.roomId);
                        }
                    }, EMPTY_ROOM_CLEANUP);
                }
            }
        }
        sockets.delete(ws);
    });

    ws.on('error', () => {});
});

function handleAction(msg, socketInfo, room) {
    const by = socketInfo.userId;
    const roomId = socketInfo.roomId;

    switch (msg.type) {
        case 'place_plan':
            if (!canPlace(socketInfo)) throw new Error('Permission denied');
            if (!validatePlan(msg.plan)) throw new Error('Invalid plan data');
            if (!checkItemLimit(room)) throw new Error('Item limit reached');
            room.data.plans.push(msg.plan);
            markDirty(roomId);
            broadcast(roomId, { type: 'plan_placed', plan: msg.plan, by });
            break;

        case 'edit_plan':
            if (!canEdit(socketInfo)) throw new Error('Permission denied');
            if (msg.index < 0 || msg.index >= room.data.plans.length) throw new Error('Invalid plan index');
            if (!validatePlan(msg.plan)) throw new Error('Invalid plan data');
            room.data.plans[msg.index] = msg.plan;
            markDirty(roomId);
            broadcast(roomId, { type: 'plan_edited', index: msg.index, plan: msg.plan, by });
            break;

        case 'delete_plan':
            if (!canDelete(socketInfo)) throw new Error('Permission denied');
            if (msg.index < 0 || msg.index >= room.data.plans.length) throw new Error('Invalid plan index');
            room.data.plans.splice(msg.index, 1);
            markDirty(roomId);
            broadcast(roomId, { type: 'plan_deleted', index: msg.index, by });
            break;

        case 'place_route':
            if (!canPlace(socketInfo)) throw new Error('Permission denied');
            if (!validateRoute(msg.route)) throw new Error('Invalid route data');
            if (!checkItemLimit(room)) throw new Error('Item limit reached');
            room.data.routes.push(msg.route);
            markDirty(roomId);
            broadcast(roomId, { type: 'route_placed', route: msg.route, by });
            break;

        case 'edit_route':
            if (!canEdit(socketInfo)) throw new Error('Permission denied');
            if (msg.index < 0 || msg.index >= room.data.routes.length) throw new Error('Invalid route index');
            if (!validateRoute(msg.route)) throw new Error('Invalid route data');
            room.data.routes[msg.index] = msg.route;
            markDirty(roomId);
            broadcast(roomId, { type: 'route_edited', index: msg.index, route: msg.route, by });
            break;

        case 'delete_route':
            if (!canDelete(socketInfo)) throw new Error('Permission denied');
            if (msg.index < 0 || msg.index >= room.data.routes.length) throw new Error('Invalid route index');
            room.data.routes.splice(msg.index, 1);
            markDirty(roomId);
            broadcast(roomId, { type: 'route_deleted', index: msg.index, by });
            break;

        case 'place_marker':
            if (!canPlace(socketInfo)) throw new Error('Permission denied');
            if (!validateMarker(msg.marker)) throw new Error('Invalid marker data');
            if (!checkItemLimit(room)) throw new Error('Item limit reached');
            room.data.markers.push(msg.marker);
            markDirty(roomId);
            broadcast(roomId, { type: 'marker_placed', marker: msg.marker, by });
            break;

        case 'edit_marker':
            if (!canEdit(socketInfo)) throw new Error('Permission denied');
            if (msg.index < 0 || msg.index >= room.data.markers.length) throw new Error('Invalid marker index');
            if (!validateMarker(msg.marker)) throw new Error('Invalid marker data');
            room.data.markers[msg.index] = msg.marker;
            markDirty(roomId);
            broadcast(roomId, { type: 'marker_edited', index: msg.index, marker: msg.marker, by });
            break;

        case 'delete_marker':
            if (!canDelete(socketInfo)) throw new Error('Permission denied');
            if (msg.index < 0 || msg.index >= room.data.markers.length) throw new Error('Invalid marker index');
            room.data.markers.splice(msg.index, 1);
            markDirty(roomId);
            broadcast(roomId, { type: 'marker_deleted', index: msg.index, by });
            break;

        case 'place_text':
            if (!canPlace(socketInfo)) throw new Error('Permission denied');
            if (!validateText(msg.text)) throw new Error('Invalid text data');
            if (!checkItemLimit(room)) throw new Error('Item limit reached');
            room.data.texts.push(msg.text);
            markDirty(roomId);
            broadcast(roomId, { type: 'text_placed', text: msg.text, by });
            break;

        case 'edit_text':
            if (!canEdit(socketInfo)) throw new Error('Permission denied');
            if (msg.index < 0 || msg.index >= room.data.texts.length) throw new Error('Invalid text index');
            if (!validateText(msg.text)) throw new Error('Invalid text data');
            room.data.texts[msg.index] = msg.text;
            markDirty(roomId);
            broadcast(roomId, { type: 'text_edited', index: msg.index, text: msg.text, by });
            break;

        case 'delete_text':
            if (!canDelete(socketInfo)) throw new Error('Permission denied');
            if (msg.index < 0 || msg.index >= room.data.texts.length) throw new Error('Invalid text index');
            room.data.texts.splice(msg.index, 1);
            markDirty(roomId);
            broadcast(roomId, { type: 'text_deleted', index: msg.index, by });
            break;

        case 'move_plan':
            if (!canEdit(socketInfo)) throw new Error('Permission denied');
            if (msg.index < 0 || msg.index >= room.data.plans.length) throw new Error('Invalid plan index');
            if (typeof msg.x !== 'number' || typeof msg.y !== 'number') throw new Error('Invalid coordinates');
            if (msg.x < -100 || msg.x > 10000 || msg.y < -100 || msg.y > 10000) throw new Error('Coordinates out of bounds');
            room.data.plans[msg.index].x = msg.x;
            room.data.plans[msg.index].y = msg.y;
            markDirty(roomId);
            broadcast(roomId, { type: 'plan_moved', index: msg.index, x: msg.x, y: msg.y, by });
            break;

        case 'move_marker':
            if (!canEdit(socketInfo)) throw new Error('Permission denied');
            if (msg.index < 0 || msg.index >= room.data.markers.length) throw new Error('Invalid marker index');
            if (typeof msg.x !== 'number' || typeof msg.y !== 'number') throw new Error('Invalid coordinates');
            if (msg.x < -100 || msg.x > 10000 || msg.y < -100 || msg.y > 10000) throw new Error('Coordinates out of bounds');
            room.data.markers[msg.index].x = msg.x;
            room.data.markers[msg.index].y = msg.y;
            markDirty(roomId);
            broadcast(roomId, { type: 'marker_moved', index: msg.index, x: msg.x, y: msg.y, by });
            break;

        case 'move_text':
            if (!canEdit(socketInfo)) throw new Error('Permission denied');
            if (msg.index < 0 || msg.index >= room.data.texts.length) throw new Error('Invalid text index');
            if (typeof msg.x !== 'number' || typeof msg.y !== 'number') throw new Error('Invalid coordinates');
            if (msg.x < -100 || msg.x > 10000 || msg.y < -100 || msg.y > 10000) throw new Error('Coordinates out of bounds');
            room.data.texts[msg.index].x = msg.x;
            room.data.texts[msg.index].y = msg.y;
            markDirty(roomId);
            broadcast(roomId, { type: 'text_moved', index: msg.index, x: msg.x, y: msg.y, by });
            break;

        case 'clear_all':
            if (socketInfo.role !== 'admin') throw new Error('Permission denied');
            room.data = makeRoomData();
            markDirty(roomId);
            broadcast(roomId, { type: 'clear_all', by });
            break;

        case 'import_data':
            if (socketInfo.role !== 'admin') throw new Error('Permission denied');
            if (msg.plans) {
                if (!Array.isArray(msg.plans) || msg.plans.length > MAX_DATA_ITEMS) throw new Error('Invalid plans array');
                room.data.plans = msg.plans;
            }
            if (msg.routes) {
                if (!Array.isArray(msg.routes) || msg.routes.length > MAX_DATA_ITEMS) throw new Error('Invalid routes array');
                room.data.routes = msg.routes;
            }
            if (msg.markers) {
                if (!Array.isArray(msg.markers) || msg.markers.length > MAX_DATA_ITEMS) throw new Error('Invalid markers array');
                room.data.markers = msg.markers;
            }
            if (msg.texts) {
                if (!Array.isArray(msg.texts) || msg.texts.length > MAX_DATA_ITEMS) throw new Error('Invalid texts array');
                room.data.texts = msg.texts;
            }
            markDirty(roomId);
            broadcast(roomId, {
                type: 'import_data',
                plans: room.data.plans, routes: room.data.routes,
                markers: room.data.markers, texts: room.data.texts, by
            });
            break;

        case 'set_role':
            if (socketInfo.role !== 'admin') throw new Error('Permission denied');
            if (msg.targetUserId === socketInfo.userId) throw new Error('Cannot change own role');
            const targetUser = room.users.get(msg.targetUserId);
            if (!targetUser) throw new Error('User not found');
            if (!['member', 'viewer'].includes(msg.role)) throw new Error('Invalid role');
            targetUser.role = msg.role;
            broadcast(roomId, { type: 'role_changed', targetUserId: msg.targetUserId, role: msg.role, by });
            broadcast(roomId, { type: 'user_list', users: getRoomUsers(roomId) });
            break;

        case 'set_permission':
            if (socketInfo.role !== 'admin') throw new Error('Permission denied');
            if (!['memberCanPlace', 'memberCanEdit', 'memberCanDelete'].includes(msg.key)) {
                throw new Error('Invalid permission key');
            }
            room.permissions[msg.key] = !!msg.value;
            markDirty(roomId);
            broadcast(roomId, { type: 'permission_changed', key: msg.key, value: room.permissions[msg.key], by });
            break;

        default:
            throw new Error(`Unknown message type: ${msg.type}`);
    }
}

// ─── Graceful Shutdown ───
function saveAll() {
    for (const [roomId] of rooms) saveRoomData(roomId);
}
process.on('SIGINT', () => { saveAll(); server.close(); process.exit(0); });
process.on('SIGTERM', () => { saveAll(); server.close(); process.exit(0); });

server.listen(PORT, () => {
    console.log(`Collab Map Editor Server running on http://localhost:${PORT}`);
});
