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

// --- CONFIG ---
const MAP_RADIUS = 12; // Big map
const MIN_PLAYERS_TO_START = 2;

// --- SUPABASE SETUP ---
// Ensure these are set in Render Environment Variables
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// --- STATE ---
let players = {}; 
let map = {}; 
let gameState = 'waiting'; // 'waiting' or 'active'

// --- HEX HELPERS ---
function getDistanceToCenter(q, r) {
    return (Math.abs(q) + Math.abs(q + r) + Math.abs(r)) / 2;
}

function getHexNeighbors(q, r) {
    const directions = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
    return directions.map(d => `${q + d[0]},${r + d[1]}`);
}

// --- MAP INIT ---
async function initMap() {
    // Try to load from DB
    const { data, error } = await supabase.from('tiles').select('*');
    
    // 1. Generate empty grid
    for (let q = -MAP_RADIUS; q <= MAP_RADIUS; q++) {
        let r1 = Math.max(-MAP_RADIUS, -q - MAP_RADIUS);
        let r2 = Math.min(MAP_RADIUS, -q + MAP_RADIUS);
        for (let r = r1; r <= r2; r++) {
            const key = `${q},${r}`;
            map[key] = { q, r, owner: 'grey', current_clicks: 0 };
        }
    }

    // 2. Overlay DB data
    if (data && data.length > 0) {
        data.forEach(tile => {
            const key = `${tile.q},${tile.r}`;
            if (map[key]) {
                map[key].owner = tile.owner;
                map[key].current_clicks = tile.current_clicks;
            }
        });
    } else {
        // First time setup: Bases
        map[`-${MAP_RADIUS},0`].owner = 'red';
        map[`${MAP_RADIUS},0`].owner = 'blue';
        
        const rows = Object.values(map).map(t => ({ q: t.q, r: t.r, owner: t.owner }));
        await supabase.from('tiles').upsert(rows, { onConflict: ['q', 'r'] });
    }
    console.log(`Map Initialized. Radius: ${MAP_RADIUS}`);
}

initMap();

// --- SOCKET LOGIC ---
io.on('connection', (socket) => {
    console.log('Player connected:', socket.id);

    // Send initial state
    socket.emit('map_update', map);
    socket.emit('game_state', gameState);
    io.emit('player_count', Object.keys(io.sockets.sockets).length); // Update everyone on count

    socket.on('join_game', () => {
        const playerCount = io.engine.clientsCount;

        if (playerCount < MIN_PLAYERS_TO_START) {
            socket.emit('notification', `Waiting for opponents... (${playerCount}/${MIN_PLAYERS_TO_START})`);
            return; // Reject join
        }

        // Enable Game if enough players
        if (gameState === 'waiting') {
            gameState = 'active';
            io.emit('game_state', 'active');
        }

        // Logic to assign team or let them choose
        const allPlayers = Object.values(players);
        const redCount = allPlayers.filter(p => p.team === 'red').length;
        const blueCount = allPlayers.filter(p => p.team === 'blue').length;

        // "If even... they choose. If odd... assigned to least."
        if ((redCount + blueCount) % 2 !== 0) {
            const forcedTeam = redCount < blueCount ? 'red' : 'blue';
            spawnPlayer(socket, forcedTeam);
        } else {
            socket.emit('request_team_choice');
        }
    });

    socket.on('choose_team', (choice) => {
        // Security check: only allow if game is active
        if (gameState !== 'active') return;
        spawnPlayer(socket, choice);
    });

    socket.on('move', (targetHex) => {
        const player = players[socket.id];
        if (!player) return;

        const targetKey = `${targetHex.q},${targetHex.r}`;
        const targetTile = map[targetKey];
        if (!targetTile) return;

        // Validation: Must be neighbor
        const neighbors = getHexNeighbors(player.q, player.r);
        if (!neighbors.includes(targetKey)) return;

        // Validation: Target tile must have a friendly neighbor OR be owned by us
        const targetNeighbors = getHexNeighbors(targetHex.q, targetHex.r);
        const hasFriendlyNeighbor = targetNeighbors.some(nKey => map[nKey] && map[nKey].owner === player.team);
        const isOwned = targetTile.owner === player.team;

        if (hasFriendlyNeighbor || isOwned) {
            player.q = targetHex.q;
            player.r = targetHex.r;
            io.emit('player_update', players);
        }
    });

    socket.on('capture_click', async () => {
        const player = players[socket.id];
        if (!player) return;

        const key = `${player.q},${player.r}`;
        const tile = map[key];

        if (tile.owner === player.team) return;

        // --- NEW DIFFICULTY LOGIC ---
        const dist = getDistanceToCenter(tile.q, tile.r);
        
        // Base difficulty based on map size. 
        // Edge (dist 12) = Easy (5 clicks). Center (dist 0) = Hard (25 clicks).
        let baseClicks = Math.floor(25 - (dist * 1.5)); 
        if (baseClicks < 5) baseClicks = 5;

        // Enemy Multiplier (1.7x)
        if (tile.owner !== 'grey') {
            baseClicks = Math.floor(baseClicks * 1.7);
        }

        tile.current_clicks += 1;

        if (tile.current_clicks >= baseClicks) {
            // Captured!
            tile.owner = player.team;
            tile.current_clicks = 0;
            
            // DB Save (Background)
            supabase.from('tiles').upsert({ 
                q: tile.q, r: tile.r, owner: tile.owner 
            }, { onConflict: ['q', 'r'] }).then();

            io.emit('map_update', map);
        } else {
            // Send progress update
            io.emit('tile_progress', { key, clicks: tile.current_clicks, required: baseClicks });
        }
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        io.emit('player_update', players);
        io.emit('player_count', io.engine.clientsCount);
    });
});

function spawnPlayer(socket, team) {
    let startQ = team === 'red' ? -MAP_RADIUS : MAP_RADIUS;
    players[socket.id] = { id: socket.id, team: team, q: startQ, r: 0 };
    socket.emit('team_assigned', team);
    io.emit('player_update', players);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
