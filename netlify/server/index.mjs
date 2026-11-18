import game from '../../server.js';
import { roomStore } from '../../db/rooms.mjs';

const instance = game.createBunkerServer({ store: roomStore });
export default instance.server;
