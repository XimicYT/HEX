// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// --- CONFIGURATION ---
const MAP_RADIUS = 12;
const MIN_PLAYERS_TO_START = 2;
const WIN_SCORE = 250000;      // Points needed to win
const SCORE_INTERVAL_MS = 5000; // Passive income every 5 seconds
const CENTER_BONUS_DIST = 4;   // Distance from center for High Value tiles

// --- SUPABASE SETUP ---
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// --- GAME STATE ---
let players = {}; 
let map = {}; 
let scores = { red: 0, blue: 0 };
let readyQueue = new Set(); // Sockets waiting to play
let gameActive = false;
let scoreInterval = null;

// --- MATH HELPERS ---
function getDistanceToCenter(q, r) {
    return (Math.abs(q) + Math.abs(q + r) + Math.abs(r)) / 2;
}

function getHexNeighbors(q, r) {
    const directions = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
    return directions.map(d => `${q + d[0]},${r + d[1]}`);
}

// --- INITIALIZATION ---
async function initMap() {
    // Reset State
    scores = { red: 0, blue: 0 };
    map = {};
    players = {}; 
    readyQueue.clear();
    gameActive = false;

    // 1. Generate empty grid
    for (let q = -MAP_RADIUS; q <= MAP_RADIUS; q++) {
        let r1 = Math.max(-MAP_RADIUS, -q - MAP_RADIUS);
        let r2 = Math.min(MAP_RADIUS, -q + MAP_RADIUS);
        for (let r = r1; r <= r2; r++) {
            const key = `${q},${r}`;
            map[key] = { q, r, owner: 'grey', current_clicks: 0 };
        }
    }

    // 2. Set Bases
    map[`-${MAP_RADIUS},0`].owner = 'red';
    map[`${MAP_RADIUS},0`].owner = 'blue';

    // 3. Sync with DB (or create if empty)
    const { data, error } = await supabase.from('tiles').select('*');
    
    if (data && data.length > 0) {
        data.forEach(tile => {
            const key = `${tile.q},${tile.r}`;
            if (map[key]) {
                map[key].owner = tile.owner;
                map[key].current_clicks = tile.current_clicks;
            }
        });
    } else {
        // DB is empty (first run or after reset), push default map
        const rows = Object.values(map).map(t => ({ q: t.q, r: t.r, owner: t.owner }));
        // Upsert in batches to avoid payload limits if necessary, but 12 radius is okay usually
        await supabase.from('tiles').upsert(rows, { onConflict: ['q', 'r'] });
    }

    console.log("Map Initialized & Ready.");
}

// Run init on server start
initMap();

// --- SCORING LOOP ---
function startGameLoop() {
    if (scoreInterval) clearInterval(scoreInterval);

    scoreInterval = setInterval(() => {
        if (!gameActive) return;

        let redGain = 0;
        let blueGain = 0;

        for (let key in map) {
            const tile = map[key];
            if (tile.owner === 'grey') continue;

            const dist = getDistanceToCenter(tile.q, tile.r);
            // High value (Inner) vs Low value (Outer)
            const points = dist <= CENTER_BONUS_DIST ? 1000 : 500;

            if (tile.owner === 'red') redGain += points;
            if (tile.owner === 'blue') blueGain += points;
        }

        scores.red += redGain;
        scores.blue += blueGain;

        io.emit('score_update', scores);

        // Check Win Condition
        if (scores.red >= WIN_SCORE || scores.blue >= WIN_SCORE) {
            const winner = scores.red >= WIN_SCORE ? 'red' : 'blue';
            endGame(winner);
        }

    }, SCORE_INTERVAL_MS);
}

// --- GAME OVER & RESET LOGIC ---
async function endGame(winner) {
    gameActive = false;
    clearInterval(scoreInterval);
    console.log(`GAME OVER: ${winner} wins! Resetting...`);
    
    io.emit('game_over', winner);

    // 1. Wipe Database
    await supabase.from('tiles').delete().neq('id', 0); // Deletes all rows safely

    // 2. Wait 5 seconds, then reset memory and kick players
    setTimeout(async () => {
        await initMap(); // Re-generate clean map in memory
        io.emit('reset_game'); // Tell clients to reload/reset
    }, 5000);
}

// --- PLAYER & SOCKET LOGIC ---
io.on('connection', (socket) => {
    // Default to spectator
    players[socket.id] = { id: socket.id, team: 'spectator', q: 0, r: 0, status: 'spectating' };
    
    // Send current state
    io.emit('player_count', io.engine.clientsCount);
    socket.emit('map_update', map);
    socket.emit('score_update', scores);
    if (gameActive) socket.emit('game_active_sync', true);

    // Player requests to join
    socket.on('request_join', () => {
        readyQueue.add(socket.id);

        if (gameActive) {
            // Late joiner logic
            assignTeam(socket.id);
            socket.emit('notification', "Joining active game!");
        } else {
            // Lobby logic
            if (readyQueue.size < MIN_PLAYERS_TO_START) {
                socket.emit('notification', `Waiting for opponent... (${readyQueue.size}/${MIN_PLAYERS_TO_START})`);
            } else {
                startGameSequence();
            }
        }
    });

    // Movement
    socket.on('move', (targetHex) => {
        const p = players[socket.id];
        // Security: Must be playing, game must be active
        if (!p || p.status !== 'playing' || !gameActive) return;

        const key = `${targetHex.q},${targetHex.r}`;
        const target = map[key];
        if (!target) return;

        // Validation: Must be a neighbor
        const neighbors = getHexNeighbors(p.q, p.r);
        if (!neighbors.includes(key)) return;

        // Validation: Must be friendly neighbor OR owned by self
        const tNeighbors = getHexNeighbors(targetHex.q, targetHex.r);
        const hasFriendly = tNeighbors.some(n => map[n] && map[n].owner === p.team);
        
        if (hasFriendly || target.owner === p.team) {
            p.q = targetHex.q; 
            p.r = targetHex.r;
            io.emit('player_update', players);
        }
    });

    // Capture
    socket.on('capture_click', () => {
        const p = players[socket.id];
        if (!p || p.status !== 'playing' || !gameActive) return;

        const tile = map[`${p.q},${p.r}`];
        // Cannot capture own tile
        if (tile.owner === p.team) return;

        // Difficulty Calculation
        const dist = getDistanceToCenter(tile.q, tile.r);
        let req = Math.max(5, Math.floor(25 - (dist * 1.5))); // Closer to center = harder
        if (tile.owner !== 'grey') req = Math.floor(req * 1.7); // Enemy tile = harder

        tile.current_clicks++;

        if (tile.current_clicks >= req) {
            // Success
            tile.owner = p.team;
            tile.current_clicks = 0;
            
            // Async DB update (don't await to keep game fast)
            supabase.from('tiles').upsert({ q: tile.q, r: tile.r, owner: tile.owner }, { onConflict: ['q','r'] }).then();
            
            io.emit('map_update', map);
        } else {
            // Progress update
            io.emit('tile_progress', { key: `${tile.q},${tile.r}`, clicks: tile.current_clicks, required: req });
        }
    });

    // Disconnect
    socket.on('disconnect', () => {
        delete players[socket.id];
        readyQueue.delete(socket.id);
        io.emit('player_update', players);
        io.emit('player_count', io.engine.clientsCount);
    });
});

// --- HELPER: Assign a team ---
function assignTeam(socketId) {
    if (!players[socketId]) return;

    // Count active players to balance
    const all = Object.values(players).filter(p => p.status === 'playing');
    const redCount = all.filter(p => p.team === 'red').length;
    const blueCount = all.filter(p => p.team === 'blue').length;

    const team = redCount > blueCount ? 'blue' : 'red';
    const startQ = team === 'red' ? -MAP_RADIUS : MAP_RADIUS;

    players[socketId].team = team;
    players[socketId].q = startQ;
    players[socketId].r = 0;
    players[socketId].status = 'playing';

    io.to(socketId).emit('team_assigned', team);
    io.emit('player_update', players);
}

// --- HELPER: Start Sequence ---
function startGameSequence() {
    // 1. Assign teams to everyone in queue
    const readyIds = Array.from(readyQueue);
    readyIds.forEach(id => assignTeam(id));
    readyQueue.clear();

    // 2. Countdown Loop
    gameActive = false;
    let count = 3;
    
    const interval = setInterval(() => {
        if (count > 0) {
            io.emit('countdown', count);
            count--;
        } else {
            io.emit('countdown', "GO!");
            gameActive = true;
            startGameLoop(); // Start the points timer
            clearInterval(interval);
            
            // Clear "GO!" text after 1 second
            setTimeout(() => io.emit('countdown', null), 1000);
        }
    }, 1000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Hex Conquest Server running on port ${PORT}`));
