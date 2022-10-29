// IMPORRTS
const http = require("http");
const express = require("express");
const socketio = require("socket.io");
const cors = require("cors");
const sirv = require("sirv");
const User = require("./user");

// ENVIRONMENT VARIABLES
const PORT = process.env.PORT || 3030;
const DEV = process.env.NODE_ENV === "development";
const TOKEN = process.env.TOKEN;
const ROOM_SIZE = process.env.ROOM_SIZE;

// SETUP SERVERS
const app = express();
app.use(express.json(), cors());
const server = http.createServer(app);
const io = socketio(server, { cors: {} });

// AUTHENTICATION MIDDLEWARE
io.use((socket, next) => {
    const token = socket.handshake.auth.token; // check the auth token provided by the client upon connection
    if (token === TOKEN) {
        next();
    } else {
        next(new Error("Authentication error"));
    }
});

let connections = new Map();
/**
 * @type {Map<string, Room>}
 */
let rooms = new Map();

/**
 * @typedef {Object} Room
 * @property {Map<string, User>} users
 */
/**
 * @param {String} room 
 * @return {Room}
 */
function getOrCreateRoom(room) {
	if (rooms.has(room) === false) {
		rooms.set(room, {
			maps: [],
			currentMapIndex: 0,
			users: new Map()
		});
	}

	return rooms.get(room);
}

/**
 * Verify an array of JSON map strings
 * @param {String[]} maps 
 */
function validMaps(maps) {
	return maps.some( (map) => {
		return !Array.isArray(map.layers) || !Array.isArray(map.entities) || map.created === undefined;
	}) === false;
}

// API ENDPOINT TO DISPLAY THE CONNECTION TO THE SIGNALING SERVER

// app.get("/connections", (req, res) => {
//     res.json(Object.values(connections));
// });

// MESSAGING LOGIC
io.on("connection", (socket) => {
    console.log("User connected with id", socket.id);

    // socket.on("ready", (peerId, peerType) => {
    //     // Make sure that the hostname is unique, if the hostname is already in connections, send an error and disconnect
    //     if (peerId in connections) {
    //         socket.emit("uniquenessError", {
    //             message: `${peerId} is already connected to the signalling server. Please change your peer ID and try again.`,
    //         });
    //         socket.disconnect(true);
    //     } else {
    //         console.log(`Added ${peerId} to connections`);
    //         // Let new peer know about all exisiting peers
    //         socket.send({ from: "all", target: peerId, payload: { action: "open", connections: Object.values(connections), bePolite: false } }); // The new peer doesn't need to be polite.
    //         // Create new peer
    //         const newPeer = { socketId: socket.id, peerId, peerType };
    //         // Updates connections object
    //         connections[peerId] = newPeer;
    //         // Let all other peers know about new peer
    //         socket.broadcast.emit("message", {
    //             from: peerId,
    //             target: "all",
    //             payload: { action: "open", connections: [newPeer], bePolite: true }, // send connections object with an array containing the only new peer and make all exisiting peers polite.
    //         });
    //     }
    // });

	socket.on('join-room', ({ nickname, room }, callback) => {
		socket.join(room);

		console.log(`${nickname} joined ${room}`)

		const roomObject = getOrCreateRoom(room);

		if (roomObject.users.size + 1 > ROOM_SIZE) {
			callback(false, {error: "This room is full"});
		}
		else {
			roomObject.users.set(socket.id, new User({
				leader: roomObject.users.size === 0, // first user of a room becomes leader
				peerID: socket.id,
				nickname,
			}));
	
			io.to(room).emit('user-joined', {
				nickname,
				users: Array.from(roomObject.users.values())
			});

			callback(true, { maps: roomObject.maps });
		}
	})

	socket.on('set-ready', ({ ready, room }, callback) => {
		if (rooms.has(room) === false) return callback(false, `Room ${room} does not exist`);

		const roomObject = rooms.get(room);
		roomObject.users.get(socket.id).ready = ready;

		io.emit('users-update', { users: Array.from(roomObject.users.values()) });

		const readyUsers = Array.from(roomObject.users.values()).filter( ({ ready }) => ready );

		if (roomObject.users.size > 1 && readyUsers.length === roomObject.users.size) {
			console.log(`Starting map in ${room}`)
			io.emit('start-map', roomObject.currentMapIndex);
		}

		callback(true);
	})

	socket.on('set-room-maps', ({ maps, room }, callback) => {
		if (rooms.has(room) === false) return callback?.(false, "Room does not exist");
		if (validMaps(maps) === false) return callback?.(false, "Illegal map data found");

		const roomObject = rooms.get(room);

		roomObject.maps = maps;

		io.to(room).emit('updated-room-maps', { room, maps });

		callback?.(true);
	})

	socket.on('leave-room', ({ nickname, room }) => {
		socket.leave(room);

		const roomObject = getOrCreateRoom(room);

		const user = roomObject.users.get(socket.id);

		roomObject.users.delete(socket.id);

		if (user?.leader) {
			const newRoomLeader = roomObject.users.values().next().value

			if (newRoomLeader) newRoomLeader.leader = true;
		}

		console.log("User left", roomObject.users.size)

		if (roomObject.users.size === 0) rooms.delete(room);

		socket.to(room).emit('user-left', {
			nickname,
			users: Array.from(roomObject.users.values())
		});
	})

	socket.on('broadcast-positions', (positions) => {
		socket.broadcast.emit('player-positions', { peerID: socket.id, positions });
	})

    socket.on("message", (message) => {
        // Send message to all peers expect the sender
        socket.broadcast.emit("message", message);
    });
    socket.on("messageOne", (message) => {
        // Send message to a specific targeted peer
        const { target } = message;
        const targetPeer = connections[target];
        if (targetPeer) {
            io.to(targetPeer.socketId).emit("message", { ...message });
        } else {
            console.log(`Target ${target} not found`);
        }
    });
    socket.on("disconnect", () => {
		rooms.forEach( (room, roomID) => {
			room.users.delete(socket.id);

			if (room.users.size === 0) rooms.delete(roomID);
		})
		
        const disconnectingPeer = Object.values(connections).find((peer) => peer.socketId === socket.id);
        if (disconnectingPeer) {
            console.log("Disconnected", socket.id, "with peerId", disconnectingPeer.peerId);
            // Make all peers close their peer channels
            socket.broadcast.emit("message", {
                from: disconnectingPeer.peerId,
                target: "all",
                payload: { action: "close", message: "Peer has left the signaling server" },
            });
            // remove disconnecting peer from connections
            delete connections[disconnectingPeer.peerId];
        } else {
            console.log(socket.id, "has disconnected");
        }
    });
});

// SERVE STATIC FILES
app.use(sirv("public", { DEV }));

// RUN APP
server.listen(PORT, console.log(`Listening on PORT ${PORT}`));
