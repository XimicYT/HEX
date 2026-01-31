const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

// --- CONFIG ---
const MAP_RADIUS = 12;
const MIN_PLAYERS_TO_START = 2;
const WIN_SCORE = 250000;
const SCORE_INTERVAL_MS = 5000;
const CENTER_BONUS_DIST = 4;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// --- STATE ---
let players = {};
let map = {};
let scores = { red: 0, blue: 0 };
let readyQueue = new Set();
let gameActive = false;
let scoreInterval = null;

// --- MAP & MATH ---
function getDistanceToCenter(q, r) { return (Math.abs(q) + Math.abs(q + r) + Math.abs(r)) / 2; }

function getHexNeighbors(q, r) {
    const directions = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
    return directions.map(d => `${q + d[0]},${r + d[1]}`);
}

async function initMap() {
    scores = { red: 0, blue: 0 };
    map = {};
    players = {};
    readyQueue.clear();
    gameActive = false; // Reset game state

    // Generate Map
    for (let q = -MAP_RADIUS; q <= MAP_RADIUS; q++) {
        let r1 = Math.max(-MAP_RADIUS, -q - MAP_RADIUS);
        let r2 = Math.min(MAP_RADIUS, -q + MAP_RADIUS);
        for (let r = r1; r <= r2; r++) {
            map[`${q},${r}`] = { q, r, owner: 'grey', current_clicks: 0 };
        }
    }
    map[`-${MAP_RADIUS},0`].owner = 'red';
    map[`${MAP_RADIUS},0`].owner = 'blue';

    // Sync DB
    const { data } = await supabase.from('tiles').select('*');
    if (data && data.length > 0) {
        data.forEach(t => {
            const k = `${t.q},${t.r}`;
            if (map[k]) { map[k].owner = t.owner; map[k].current_clicks = t.current_clicks; }
        });
    } else {
        const rows = Object.values(map).map(t => ({ q: t.q, r: t.r, owner: t.owner }));
        await supabase.from('tiles').upsert(rows, { onConflict: ['q', 'r'] });
    }
    console.log("Map Initialized");
}
initMap();

// --- LOOP ---
function startGameLoop() {
    if (scoreInterval) clearInterval(scoreInterval);
    scoreInterval = setInterval(() => {
        if (!gameActive) return;

        let redGain = 0; let blueGain = 0;
        for (let key in map) {
            const t = map[key];
            if (t.owner === 'grey') continue;
            const dist = getDistanceToCenter(t.q, t.r);
            const points = dist <= CENTER_BONUS_DIST ? 1000 : 500;
            if (t.owner === 'red') redGain += points;
            if (t.owner === 'blue') blueGain += points;
        }

        scores.red += redGain;
        scores.blue += blueGain;
        io.emit('score_update', scores);

        if (scores.red >= WIN_SCORE || scores.blue >= WIN_SCORE) {
            endGame(scores.red >= WIN_SCORE ? 'red' : 'blue');
        }
    }, SCORE_INTERVAL_MS);
}

async function endGame(winner) {
    gameActive = false;
    clearInterval(scoreInterval);
    io.emit('game_over', winner);

    // Wipe DB
    await supabase.from('tiles').delete().neq('id', 0);

    setTimeout(async () => {
        await initMap();
        io.emit('reset_game');
    }, 5000);
}

// --- SOCKETS ---
io.on('connection', (socket) => {
    players[socket.id] = { id: socket.id, team: 'spectator', q: 0, r: 0, status: 'spectating' };

    io.emit('player_count', io.engine.clientsCount);
    socket.emit('map_update', map);
    socket.emit('score_update', scores);

    // If joining mid-game, send active status so client knows
    if (gameActive) socket.emit('game_active_sync', true);

    socket.on('request_join', () => {
        readyQueue.add(socket.id);

        if (gameActive) {
            // 3RD PLAYER LOGIC: If game is active, JOIN IMMEDIATELY
            assignTeam(socket.id);
            socket.emit('notification', "Reinforcements arriving!");
        } else {
            // Lobby Logic
            if (readyQueue.size < MIN_PLAYERS_TO_START) {
                socket.emit('notification', `Waiting for pilots... (${readyQueue.size}/${MIN_PLAYERS_TO_START})`);
            } else {
                startGameSequence();
            }
        }
    });

    socket.on('move', (targetHex) => {
        const p = players[socket.id];
        if (!p || p.status !== 'playing' || !gameActive) return;

        const key = `${targetHex.q},${targetHex.r}`;
        const target = map[key];
        if (!target) return;

        const neighbors = getHexNeighbors(p.q, p.r);
        if (!neighbors.includes(key)) return;

        const tNeighbors = getHexNeighbors(targetHex.q, targetHex.r);
        const hasFriendly = tNeighbors.some(n => map[n] && map[n].owner === p.team);

        if (hasFriendly || target.owner === p.team) {
            p.q = targetHex.q; p.r = targetHex.r;
            io.emit('player_update', players);
        }
    });

    socket.on('capture_click', () => {
        const p = players[socket.id];
        if (!p || p.status !== 'playing' || !gameActive) return;

        const tile = map[`${p.q},${p.r}`];
        if (tile.owner === p.team) return;

        const dist = getDistanceToCenter(tile.q, tile.r);
        let req = Math.max(5, Math.floor(25 - (dist * 1.5)));
        if (tile.owner !== 'grey') req = Math.floor(req * 1.7);

        tile.current_clicks++;
        if (tile.current_clicks >= req) {
            tile.owner = p.team;
            tile.current_clicks = 0;
            supabase.from('tiles').upsert({ q: tile.q, r: tile.r, owner: tile.owner }, { onConflict: ['q', 'r'] }).then();
            io.emit('map_update', map);
        } else {
            io.emit('tile_progress', { key: `${tile.q},${tile.r}`, clicks: tile.current_clicks, required: req });
        }
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        readyQueue.delete(socket.id);
        io.emit('player_update', players);
        io.emit('player_count', io.engine.clientsCount);
    });
});

function assignTeam(socketId) {
    if (!players[socketId]) return;

    const all = Object.values(players).filter(p => p.status === 'playing');
    const red = all.filter(p => p.team === 'red').length;
    const blue = all.filter(p => p.team === 'blue').length;

    // Balance teams
    const team = red > blue ? 'blue' : 'red';
    const startQ = team === 'red' ? -MAP_RADIUS : MAP_RADIUS;

    players[socketId].team = team;
    players[socketId].q = startQ;
    players[socketId].r = 0;
    players[socketId].status = 'playing';

    io.to(socketId).emit('team_assigned', team);
    io.emit('player_update', players);
}

function startGameSequence() {
    const readyIds = Array.from(readyQueue);
    readyIds.forEach(id => assignTeam(id));
    readyQueue.clear();

    // Game is "Active" during countdown to allow spawning, but clients block input until "GO"
    gameActive = true;
    let count = 3;

    const interval = setInterval(() => {
        if (count > 0) {
            io.emit('countdown', count);
            count--;
        } else {
            io.emit('countdown', "GO!");
            startGameLoop();
            clearInterval(interval);
            setTimeout(() => io.emit('countdown', null), 1000);
        }
    }, 1000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
