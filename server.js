const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = 3456;
const DATA_DIR = path.join(__dirname, 'data');
const SAVE_INTERVAL = 30000; // 30s auto-save

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ─── Room & User State ───
const rooms = new Map();    // roomId -> { id, name, password, creator, data, users, permissions }
const sockets = new Map();  // socket -> { userId, username, roomId, role, ws }

// Generate 6-digit random room code
function generateRoomId() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let id = '';
    for (let i = 0; i < 6; i++) {
        id += chars[crypto.randomInt(chars.length)];
    }
    // Check uniqueness
    if (rooms.has(id)) return generateRoomId();
    return id;
}

function generateUserId() {
    return crypto.randomBytes(8).toString('hex');
}

function makeRoomData() {
    return {
        plans: [],
        routes: [],
        markers: [],
        texts: []
    };
}

function loadRoomData(roomId) {
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

// Periodic auto-save
setInterval(() => {
    for (const [roomId, room] of rooms) {
        if (room.dirty) {
            saveRoomData(roomId);
            room.dirty = false;
        }
    }
}, SAVE_INTERVAL);

function markDirty(roomId) {
    const room = rooms.get(roomId);
    if (room) room.dirty = true;
}

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

const server = http.createServer((req, res) => {
    // API routes
    if (req.method === 'POST' && req.url === '/api/rooms') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { name, password } = JSON.parse(body);
                const roomId = generateRoomId();
                rooms.set(roomId, {
                    id: roomId,
                    name: name || 'Untitled Room',
                    password: password || '',
                    creator: null, // set when admin joins
                    data: makeRoomData(),
                    users: new Map(), // userId -> { userId, username, role, ws }
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

    if (req.method === 'GET' && req.url.startsWith('/api/rooms/')) {
        const roomId = req.url.split('/').pop();
        const room = rooms.get(roomId);
        if (!room) {
            res.writeHead(404);
            res.end(JSON.stringify({ error: 'Room not found' }));
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            roomId: room.id,
            name: room.name,
            hasPassword: !!room.password,
            userCount: room.users.size
        }));
        return;
    }

    // Static file serving - serve index.html for / or /collab/
    let filePath = req.url;
    if (filePath === '/' || filePath === '/collab/' || filePath === '/collab') {
        filePath = '/collab/index.html';
    }
    if (!filePath.startsWith('/collab/')) {
        filePath = '/collab' + filePath;
    }

    const fullPath = path.join(__dirname, filePath);
    const ext = path.extname(fullPath).toLowerCase();
    const mimeType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(fullPath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('Not Found');
            return;
        }
        res.writeHead(200, { 'Content-Type': mimeType });
        res.end(data);
    });
});

// ─── WebSocket Server ───
const wss = new WebSocket.Server({ server });

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
        users.push({ userId, username: user.username, role: user.role });
    }
    return users;
}

// Permission checks
function canPlace(socketInfo) {
    if (socketInfo.role === 'viewer') return false;
    if (socketInfo.role === 'admin') return true;
    // member: check permissions
    const room = rooms.get(socketInfo.roomId);
    if (!room) return false;
    return room.permissions.memberCanPlace !== false;
}

function canEdit(socketInfo, itemIndex) {
    if (socketInfo.role === 'viewer') return false;
    if (socketInfo.role === 'admin') return true;
    // member: check permissions - can only edit own items? For simplicity, if memberCanEdit, allow all
    const room = rooms.get(socketInfo.roomId);
    if (!room) return false;
    return room.permissions.memberCanEdit !== false;
}

function canDelete(socketInfo) {
    if (socketInfo.role === 'viewer') return false;
    if (socketInfo.role === 'admin') return true;
    const room = rooms.get(socketInfo.roomId);
    if (!room) return false;
    return room.permissions.memberCanDelete !== false;
}

wss.on('connection', (ws) => {
    const socketInfo = { userId: null, username: null, roomId: null, role: null, ws };

    ws.on('message', (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw.toString());
        } catch (e) {
            sendError(ws, 'Invalid message format');
            return;
        }

        switch (msg.type) {
            case 'join': {
                const { roomId, password, username } = msg;
                if (!roomId || !username) {
                    sendError(ws, 'Missing roomId or username');
                    return;
                }

                const room = rooms.get(roomId);
                if (!room) {
                    sendError(ws, 'Room not found');
                    return;
                }

                if (room.password && room.password !== (password || '')) {
                    sendError(ws, 'Wrong password');
                    return;
                }

                // Assign userId and role
                const userId = generateUserId();
                let role = 'member';
                if (!room.creator) {
                    role = 'admin';
                    room.creator = userId;
                }

                socketInfo.userId = userId;
                socketInfo.username = username;
                socketInfo.roomId = roomId;
                socketInfo.role = role;

                room.users.set(userId, { userId, username, role, ws });

                // Send joined with full room data
                sendTo(ws, {
                    type: 'joined',
                    userId,
                    username,
                    room: room.data,
                    users: getRoomUsers(roomId),
                    role,
                    permissions: room.permissions,
                    roomName: room.name
                });

                // Broadcast to others
                broadcast(roomId, {
                    type: 'user_joined',
                    userId,
                    username,
                    role
                }, userId);

                console.log(`User ${username} (${role}) joined room ${roomId}`);
                break;
            }

            // All subsequent messages require auth
            case 'place_plan':
            case 'edit_plan':
            case 'delete_plan':
            case 'place_route':
            case 'edit_route':
            case 'delete_route':
            case 'place_marker':
            case 'edit_marker':
            case 'delete_marker':
            case 'place_text':
            case 'edit_text':
            case 'delete_text':
            case 'move_plan':
            case 'move_marker':
            case 'move_text':
            case 'clear_all':
            case 'import_data':
            case 'set_role':
            case 'set_permission': {
                if (!socketInfo.roomId) {
                    sendError(ws, 'Not joined a room');
                    return;
                }

                const room = rooms.get(socketInfo.roomId);
                if (!room) {
                    sendError(ws, 'Room not found');
                    return;
                }

                // Handle each action
                try {
                    handleAction(msg, socketInfo, room);
                } catch (e) {
                    console.error('Action error:', e.message);
                    sendError(ws, e.message);
                }
                break;
            }

            default:
                sendError(ws, `Unknown message type: ${msg.type}`);
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

                // If admin left and no one else, clean up? Keep room alive for now
                // Clean up empty rooms after a while
                if (room.users.size === 0) {
                    // Save data before potential cleanup
                    saveRoomData(socketInfo.roomId);
                    // Remove from memory (data stays on disk)
                    setTimeout(() => {
                        const r = rooms.get(socketInfo.roomId);
                        if (r && r.users.size === 0) {
                            rooms.delete(socketInfo.roomId);
                            console.log(`Room ${socketInfo.roomId} cleaned up (empty)`);
                        }
                    }, 60000); // 1 minute grace period
                }

                console.log(`User ${socketInfo.username} left room ${socketInfo.roomId}`);
            }
        }
        sockets.delete(ws);
    });
});

function handleAction(msg, socketInfo, room) {
    const by = socketInfo.userId;
    const roomId = socketInfo.roomId;

    switch (msg.type) {
        case 'place_plan':
            if (!canPlace(socketInfo)) throw new Error('Permission denied: cannot place plans');
            room.data.plans.push(msg.plan);
            markDirty(roomId);
            broadcast(roomId, { type: 'plan_placed', plan: msg.plan, by });
            break;

        case 'edit_plan':
            if (!canEdit(socketInfo)) throw new Error('Permission denied: cannot edit plans');
            if (msg.index < 0 || msg.index >= room.data.plans.length) throw new Error('Invalid plan index');
            room.data.plans[msg.index] = msg.plan;
            markDirty(roomId);
            broadcast(roomId, { type: 'plan_edited', index: msg.index, plan: msg.plan, by });
            break;

        case 'delete_plan':
            if (!canDelete(socketInfo)) throw new Error('Permission denied: cannot delete plans');
            if (msg.index < 0 || msg.index >= room.data.plans.length) throw new Error('Invalid plan index');
            room.data.plans.splice(msg.index, 1);
            markDirty(roomId);
            broadcast(roomId, { type: 'plan_deleted', index: msg.index, by });
            break;

        case 'place_route':
            if (!canPlace(socketInfo)) throw new Error('Permission denied: cannot place routes');
            room.data.routes.push(msg.route);
            markDirty(roomId);
            broadcast(roomId, { type: 'route_placed', route: msg.route, by });
            break;

        case 'edit_route':
            if (!canEdit(socketInfo)) throw new Error('Permission denied: cannot edit routes');
            if (msg.index < 0 || msg.index >= room.data.routes.length) throw new Error('Invalid route index');
            room.data.routes[msg.index] = msg.route;
            markDirty(roomId);
            broadcast(roomId, { type: 'route_edited', index: msg.index, route: msg.route, by });
            break;

        case 'delete_route':
            if (!canDelete(socketInfo)) throw new Error('Permission denied: cannot delete routes');
            if (msg.index < 0 || msg.index >= room.data.routes.length) throw new Error('Invalid route index');
            room.data.routes.splice(msg.index, 1);
            markDirty(roomId);
            broadcast(roomId, { type: 'route_deleted', index: msg.index, by });
            break;

        case 'place_marker':
            if (!canPlace(socketInfo)) throw new Error('Permission denied: cannot place markers');
            room.data.markers.push(msg.marker);
            markDirty(roomId);
            broadcast(roomId, { type: 'marker_placed', marker: msg.marker, by });
            break;

        case 'edit_marker':
            if (!canEdit(socketInfo)) throw new Error('Permission denied: cannot edit markers');
            if (msg.index < 0 || msg.index >= room.data.markers.length) throw new Error('Invalid marker index');
            room.data.markers[msg.index] = msg.marker;
            markDirty(roomId);
            broadcast(roomId, { type: 'marker_edited', index: msg.index, marker: msg.marker, by });
            break;

        case 'delete_marker':
            if (!canDelete(socketInfo)) throw new Error('Permission denied: cannot delete markers');
            if (msg.index < 0 || msg.index >= room.data.markers.length) throw new Error('Invalid marker index');
            room.data.markers.splice(msg.index, 1);
            markDirty(roomId);
            broadcast(roomId, { type: 'marker_deleted', index: msg.index, by });
            break;

        case 'place_text':
            if (!canPlace(socketInfo)) throw new Error('Permission denied: cannot place texts');
            room.data.texts.push(msg.text);
            markDirty(roomId);
            broadcast(roomId, { type: 'text_placed', text: msg.text, by });
            break;

        case 'edit_text':
            if (!canEdit(socketInfo)) throw new Error('Permission denied: cannot edit texts');
            if (msg.index < 0 || msg.index >= room.data.texts.length) throw new Error('Invalid text index');
            room.data.texts[msg.index] = msg.text;
            markDirty(roomId);
            broadcast(roomId, { type: 'text_edited', index: msg.index, text: msg.text, by });
            break;

        case 'delete_text':
            if (!canDelete(socketInfo)) throw new Error('Permission denied: cannot delete texts');
            if (msg.index < 0 || msg.index >= room.data.texts.length) throw new Error('Invalid text index');
            room.data.texts.splice(msg.index, 1);
            markDirty(roomId);
            broadcast(roomId, { type: 'text_deleted', index: msg.index, by });
            break;

        case 'move_plan':
            if (!canEdit(socketInfo)) throw new Error('Permission denied: cannot move plans');
            if (msg.index < 0 || msg.index >= room.data.plans.length) throw new Error('Invalid plan index');
            room.data.plans[msg.index].x = msg.x;
            room.data.plans[msg.index].y = msg.y;
            markDirty(roomId);
            broadcast(roomId, { type: 'plan_moved', index: msg.index, x: msg.x, y: msg.y, by }, by);
            break;

        case 'move_marker':
            if (!canEdit(socketInfo)) throw new Error('Permission denied: cannot move markers');
            if (msg.index < 0 || msg.index >= room.data.markers.length) throw new Error('Invalid marker index');
            room.data.markers[msg.index].x = msg.x;
            room.data.markers[msg.index].y = msg.y;
            markDirty(roomId);
            broadcast(roomId, { type: 'marker_moved', index: msg.index, x: msg.x, y: msg.y, by }, by);
            break;

        case 'move_text':
            if (!canEdit(socketInfo)) throw new Error('Permission denied: cannot move texts');
            if (msg.index < 0 || msg.index >= room.data.texts.length) throw new Error('Invalid text index');
            room.data.texts[msg.index].x = msg.x;
            room.data.texts[msg.index].y = msg.y;
            markDirty(roomId);
            broadcast(roomId, { type: 'text_moved', index: msg.index, x: msg.x, y: msg.y, by }, by);
            break;

        case 'clear_all':
            if (socketInfo.role !== 'admin') throw new Error('Permission denied: admin only');
            room.data = makeRoomData();
            markDirty(roomId);
            broadcast(roomId, { type: 'clear_all', by });
            break;

        case 'import_data':
            if (socketInfo.role !== 'admin') throw new Error('Permission denied: admin only');
            if (msg.plans) room.data.plans = msg.plans;
            if (msg.routes) room.data.routes = msg.routes;
            if (msg.markers) room.data.markers = msg.markers;
            if (msg.texts) room.data.texts = msg.texts;
            markDirty(roomId);
            broadcast(roomId, {
                type: 'import_data',
                plans: room.data.plans,
                routes: room.data.routes,
                markers: room.data.markers,
                texts: room.data.texts,
                by
            });
            break;

        case 'set_role':
            if (socketInfo.role !== 'admin') throw new Error('Permission denied: admin only');
            const targetUser = room.users.get(msg.targetUserId);
            if (!targetUser) throw new Error('User not found');
            if (!['member', 'viewer'].includes(msg.role)) throw new Error('Invalid role');
            targetUser.role = msg.role;
            broadcast(roomId, { type: 'role_changed', targetUserId: msg.targetUserId, role: msg.role, by });
            // Also send updated user list
            broadcast(roomId, { type: 'user_list', users: getRoomUsers(roomId) });
            break;

        case 'set_permission':
            if (socketInfo.role !== 'admin') throw new Error('Permission denied: admin only');
            if (!['memberCanPlace', 'memberCanEdit', 'memberCanDelete'].includes(msg.key)) {
                throw new Error('Invalid permission key');
            }
            room.permissions[msg.key] = !!msg.value;
            markDirty(roomId);
            broadcast(roomId, { type: 'permission_changed', key: msg.key, value: room.permissions[msg.key], by });
            break;
    }
}

// ─── Graceful Shutdown ───
process.on('SIGINT', () => {
    console.log('\nShutting down, saving all rooms...');
    for (const [roomId, room] of rooms) {
        saveRoomData(roomId);
    }
    server.close();
    process.exit(0);
});

process.on('SIGTERM', () => {
    for (const [roomId, room] of rooms) {
        saveRoomData(roomId);
    }
    server.close();
    process.exit(0);
});

server.listen(PORT, () => {
    console.log(`Collab Map Editor Server running on http://localhost:${PORT}`);
    console.log(`WebSocket: ws://localhost:${PORT}`);
    console.log(`Data directory: ${DATA_DIR}`);
});
