const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

// Supabase Connection
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

let mapData = {}; 
let players = {};

// --- UTILS ---
function getDistance(q1, r1, q2, r2) {
    return (Math.abs(q1 - q2) + Math.abs(q1 + r1 - q2 - r2) + Math.abs(r1 - r2)) / 2;
}

// Check if a tile is touching the team's territory
function isConnected(q, r, team) {
    const neighbors = [
        [1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]
    ];
    return neighbors.some(([dq, dr]) => {
        const neighbor = mapData[`${q + dq},${r + dr}`];
        return neighbor && neighbor.owner === team;
    });
}

// --- GAME LOGIC ---
io.on('connection', (socket) => {
    
    socket.on('joinGame', () => {
        const counts = { red: 0, blue: 0 };
        Object.values(players).forEach(p => counts[p.team]++);
        
        // Team Assignment Logic
        let team;
        if (counts.red === counts.blue) {
            team = Math.random() > 0.5 ? 'red' : 'blue';
        } else {
            team = counts.red < counts.blue ? 'red' : 'blue';
        }

        players[socket.id] = {
            id: socket.id,
            team: team,
            q: team === 'red' ? -5 : 5,
            r: 0
        };

        socket.emit('init', { id: socket.id, team, players, mapData });
        io.emit('playerJoined', players[socket.id]);
    });

    socket.on('move', ({ q, r }) => {
        const p = players[socket.id];
        if (!p) return;

        // Rule: Can only move to tiles touching your color
        // Exception: Starting tiles or if you already own it
        const tile = mapData[`${q},${r}`];
        const canMove = (tile && tile.owner === p.team) || isConnected(q, r, p.team);

        if (getDistance(p.q, p.r, q, r) === 1 && canMove) {
            p.q = q;
            p.r = r;
            io.emit('playerMoved', { id: socket.id, q, r });
        }
    });

    socket.on('capture', async () => {
        const p = players[socket.id];
        if (!p) return;

        const key = `${p.q},${p.r}`;
        const tile = mapData[key];

        if (tile && tile.owner !== p.team) {
            // Distance difficulty: Further from center (0,0) = easier
            const dist = getDistance(0, 0, p.q, p.r);
            const teamSize = Object.values(players).filter(pl => pl.team === p.team).length;
            
            // Formula: Base 10 clicks, reduced by team size, increased by proximity to center
            const required = Math.max(2, (15 - dist) - teamSize);
            
            tile.clicks = (tile.clicks || 0) + 1;

            if (tile.clicks >= required) {
                tile.owner = p.team;
                tile.clicks = 0;
                // Save to Supabase
                await supabase.from('tiles').update({ owner: p.team }).match({ q: p.q, r: p.r });
                io.emit('tileCaptured', { q: p.q, r: p.r, owner: p.team });
            }
        }
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        io.emit('playerLeft', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server active on port ${PORT}`));