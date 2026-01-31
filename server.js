// server.js
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

// --- DB SETUP ---
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// --- STATE ---
let players = {}; // { socketId: { team, q, r, status: 'spectating'|'playing' } }
let map = {}; 
let readyQueue = new Set(); // Sockets waiting to play
let gameActive = false;

// --- HELPERS ---
function getDistanceToCenter(q, r) { return (Math.abs(q) + Math.abs(q + r) + Math.abs(r)) / 2; }
function getHexNeighbors(q, r) {
    const directions = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
    return directions.map(d => `${q + d[0]},${r + d[1]}`);
}

// --- INIT MAP ---
async function initMap() {
    const { data } = await supabase.from('tiles').select('*');
    for (let q = -MAP_RADIUS; q <= MAP_RADIUS; q++) {
        let r1 = Math.max(-MAP_RADIUS, -q - MAP_RADIUS);
        let r2 = Math.min(MAP_RADIUS, -q + MAP_RADIUS);
        for (let r = r1; r <= r2; r++) {
            map[`${q},${r}`] = { q, r, owner: 'grey', current_clicks: 0 };
        }
    }
    // Bases
    map[`-${MAP_RADIUS},0`].owner = 'red';
    map[`${MAP_RADIUS},0`].owner = 'blue';

    if (data && data.length > 0) {
        data.forEach(t => {
            const k = `${t.q},${t.r}`;
            if(map[k]) { map[k].owner = t.owner; map[k].current_clicks = t.current_clicks; }
        });
    } else {
        const rows = Object.values(map).map(t => ({ q: t.q, r: t.r, owner: t.owner }));
        await supabase.from('tiles').upsert(rows, { onConflict: ['q', 'r'] });
    }
    console.log("Map Loaded");
}
initMap();

// --- GAME LOGIC ---
io.on('connection', (socket) => {
    console.log('Connected:', socket.id);
    
    // Initial Spectator State
    players[socket.id] = { id: socket.id, team: 'spectator', q: 0, r: 0, status: 'spectating' };
    
    // Broadcast Updates
    io.emit('player_count', io.engine.clientsCount);
    socket.emit('map_update', map);

    socket.on('request_join', () => {
        // Player wants to play
        readyQueue.add(socket.id);

        if (readyQueue.size < MIN_PLAYERS_TO_START) {
            socket.emit('notification', `Waiting for opponent... (1/${MIN_PLAYERS_TO_START})`);
            return;
        }

        // We have enough players, START THE MATCH
        startGameSequence();
    });

    socket.on('choose_team', (choice) => {
        // Only valid if we asked them to choose (simplified here to auto-assign for speed or robust checks)
        // For this logic, we assign teams in startGameSequence to ensure balance
    });

    socket.on('move', (targetHex) => {
        const p = players[socket.id];
        if (!p || p.status !== 'playing') return; // Cannot move if not playing
        if (!gameActive) return; // Cannot move if game frozen

        const key = `${targetHex.q},${targetHex.r}`;
        const target = map[key];
        if (!target) return;

        // Neighbor check
        const neighbors = getHexNeighbors(p.q, p.r);
        if (!neighbors.includes(key)) return;

        // Friendly neighbor check
        const tNeighbors = getHexNeighbors(targetHex.q, targetHex.r);
        const hasFriendly = tNeighbors.some(n => map[n] && map[n].owner === p.team);
        const isOwned = target.owner === p.team;

        if (hasFriendly || isOwned) {
            p.q = targetHex.q;
            p.r = targetHex.r;
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
            supabase.from('tiles').upsert({ q: tile.q, r: tile.r, owner: tile.owner }, { onConflict: ['q','r'] }).then();
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

function startGameSequence() {
    // 1. Assign Teams to Ready Players
    const readyIds = Array.from(readyQueue);
    // Simple alternating assignment
    readyIds.forEach((id, index) => {
        const team = index % 2 === 0 ? 'red' : 'blue';
        const startQ = team === 'red' ? -MAP_RADIUS : MAP_RADIUS;
        
        if (players[id]) {
            players[id].team = team;
            players[id].q = startQ;
            players[id].r = 0;
            players[id].status = 'playing';
            
            io.to(id).emit('team_assigned', team);
        }
    });

    // 2. Teleport & Update
    io.emit('player_update', players);
    
    // 3. Start Countdown
    gameActive = false; // Freeze input
    let count = 3;
    
    const interval = setInterval(() => {
        if (count > 0) {
            io.emit('countdown', count);
            count--;
        } else {
            io.emit('countdown', "GO!");
            gameActive = true; // Unlock input
            clearInterval(interval);
            setTimeout(() => io.emit('countdown', null), 1000); // Clear text
        }
    }, 1000);
    
    // Clear queue so others can join next batch or handle mid-game joins differently
    // For now, we keep them in queue? Let's clear to prevent double assignment
    readyQueue.clear(); 
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
