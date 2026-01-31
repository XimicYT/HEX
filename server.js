// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
// Allow connections from anywhere (for your "host anywhere" requirement)
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Initialize Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Game State (In-Memory for speed, synced to DB)
let players = {}; // { socketId: { team, q, r, id } }
let map = {}; // Key: "q,r", Value: { q, r, owner, clicks, maxClicks }
const MAP_RADIUS = 6; // Size of map

// --- HELPER: Hex Logic ---
function getHexNeighbors(q, r) {
    const directions = [
        [1, 0], [1, -1], [0, -1],
        [-1, 0], [-1, 1], [0, 1]
    ];
    return directions.map(d => `${q + d[0]},${r + d[1]}`);
}

function getDistanceToCenter(q, r) {
    return (Math.abs(q) + Math.abs(q + r) + Math.abs(r)) / 2;
}

// --- INIT: Load or Create Map ---
async function initMap() {
    const { data, error } = await supabase.from('tiles').select('*');
    
    // Generate Grid coordinates
    for (let q = -MAP_RADIUS; q <= MAP_RADIUS; q++) {
        let r1 = Math.max(-MAP_RADIUS, -q - MAP_RADIUS);
        let r2 = Math.min(MAP_RADIUS, -q + MAP_RADIUS);
        for (let r = r1; r <= r2; r++) {
            const key = `${q},${r}`;
            // Default stats
            map[key] = { q, r, owner: 'grey', current_clicks: 0 };
        }
    }

    // Apply DB state
    if (data && data.length > 0) {
        data.forEach(tile => {
            const key = `${tile.q},${tile.r}`;
            if (map[key]) {
                map[key].owner = tile.owner;
                map[key].current_clicks = tile.current_clicks;
            }
        });
    } else {
        // First run: Set starting zones
        map[`-${MAP_RADIUS},0`].owner = 'red'; // Red Base
        map[`${MAP_RADIUS},0`].owner = 'blue'; // Blue Base
        
        // Sync Initial State to DB
        const rows = Object.values(map).map(t => ({ q: t.q, r: t.r, owner: t.owner }));
        await supabase.from('tiles').upsert(rows, { onConflict: ['q', 'r'] });
    }
    console.log("Map Initialized");
}

initMap();

// --- SOCKET LOGIC ---
io.on('connection', (socket) => {
    console.log('Player connected:', socket.id);

    // Send current map state immediately
    socket.emit('map_update', map);

    socket.on('join_game', () => {
        // Count teams
        const allPlayers = Object.values(players);
        const redCount = allPlayers.filter(p => p.team === 'red').length;
        const blueCount = allPlayers.filter(p => p.team === 'blue').length;

        let team = '';
        
        // Team Assignment Logic
        if ((redCount + blueCount) % 2 === 0) {
            // Even: User choice handled on client, but for now we auto-balance or let client request.
            // Simplified: Auto-assign if even to allow immediate play, or wait for client selection.
            // Requirement: "if even... they choose". 
            // We'll tell client to show chooser.
            socket.emit('request_team_choice');
            return; 
        } else {
            // Odd: Assign to smaller team
            team = redCount < blueCount ? 'red' : 'blue';
            spawnPlayer(socket, team);
        }
    });

    socket.on('choose_team', (choice) => {
        spawnPlayer(socket, choice);
    });

    socket.on('move', (targetHex) => {
        const player = players[socket.id];
        if (!player) return;

        const targetKey = `${targetHex.q},${targetHex.r}`;
        const targetTile = map[targetKey];
        
        if (!targetTile) return;

        // Validation 1: Adjacency
        const neighbors = getHexNeighbors(player.q, player.r);
        if (!neighbors.includes(targetKey)) return; // Not neighbor (cheat check)

        // Validation 2: "Touching their color"
        // The rule: "only go onto tiles that are touching their color tiles"
        // AND "if grey/enemy... as long as that tile is touching one of that teams tiles"
        // Simplified: The TARGET tile must have at least one neighbor that is owned by the player's team.
        const targetNeighbors = getHexNeighbors(targetHex.q, targetHex.r);
        const hasFriendlyNeighbor = targetNeighbors.some(nKey => map[nKey] && map[nKey].owner === player.team);
        
        // Special Case: If moving inside own territory, always allowed?
        // The prompt says "only go onto tiles that are touching their color tiles". 
        // If the tile is OWNED by them, it touches itself? Let's assume yes.
        const isOwned = targetTile.owner === player.team;

        if (hasFriendlyNeighbor || isOwned) {
            player.q = targetHex.q;
            player.r = targetHex.r;
            io.emit('player_update', players);
        }
    });

    socket.on('capture_attempt', async () => {
        const player = players[socket.id];
        if (!player) return;
        
        const key = `${player.q},${player.r}`;
        const tile = map[key];

        if (tile.owner === player.team) return; // Already owned

        // Calc Difficulty
        const dist = getDistanceToCenter(tile.q, tile.r);
        const teamCount = Object.values(players).filter(p => p.team === player.team).length || 1;
        
        // Logic: Closer to center = Harder. More players = Easier? Or More players = Harder to balance?
        // Let's do: Base 5 clicks + (5 - distance). Center is hardest (5+5=10). Edge is easiest.
        // Divide by team count to make zerg rushing effective.
        let required = Math.max(1, Math.floor((15 - dist) + (teamCount * 0.5)));

        tile.current_clicks += 1;

        if (tile.current_clicks >= required) {
            // Captured!
            tile.owner = player.team;
            tile.current_clicks = 0;
            
            // Persist to DB
            supabase.from('tiles').upsert({ 
                q: tile.q, r: tile.r, owner: tile.owner 
            }, { onConflict: ['q', 'r'] }).then(() => {
                // Background save, don't await
            });
            
            io.emit('map_update', map); // Broadcast full map change
        } else {
            // Send partial update (health bar)
            io.emit('tile_progress', { key, clicks: tile.current_clicks, required });
        }
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        io.emit('player_update', players);
        console.log('Player disconnected');
    });
});

function spawnPlayer(socket, team) {
    // Find a valid spawn point (a tile owned by their team)
    // Default to base if nothing else
    let startQ = team === 'red' ? -MAP_RADIUS : MAP_RADIUS;
    let startR = 0;

    // Optional: Spawn on a random tile owned by team?
    // Let's stick to base for simplicity to ensure they don't get stuck.
    
    players[socket.id] = {
        id: socket.id,
        team: team,
        q: startQ,
        r: startR
    };

    socket.emit('team_assigned', team);
    io.emit('player_update', players);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
