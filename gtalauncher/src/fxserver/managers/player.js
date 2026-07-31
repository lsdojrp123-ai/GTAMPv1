// src/fxserver/managers/player.js
/**
 * Player Manager
 *
 * Each connected client has a Player instance that owns exactly one ped entity.
 */
const { Entity } = require('./entity');

class Player {
  constructor(netId, name, endpoint, token) {
    this.netId = netId;
    this.name = name;
    this.endpoint = endpoint;
    this.token = token;
    this.ped = null;          // Entity of type 'player'
    this.vehicle = null;      // vehicle entity if in one
    this.spawned = false;
    this.lastInput = null;
    this.lastPing = 0;
    this.pingMs = 0;
    this.dimension = 0;
    this.kills = 0;
    this.deaths = 0;
    this.money = 0;
    this.joinedAt = Date.now();
    this.eventQueue = [];
  }

  send(packet) {
    if (this.endpoint && this.endpoint.send) this.endpoint.send(packet);
  }
}

class PlayerManager {
  constructor(entityMgr) {
    this.em = entityMgr;
    this.players = new Map(); // netId -> Player
    this._nextId = 1;
  }

  add(name, endpoint, token) {
    const netId = this._nextId++;
    const p = new Player(netId, name, endpoint, token);
    p.ped = this.em.create('player', netId);
    p.ped.health = 200;
    this.players.set(netId, p);
    return p;
  }

  remove(netId) {
    const p = this.players.get(netId);
    if (p) {
      if (p.ped) this.em.remove(p.ped.id);
      if (p.vehicle) { /* leave vehicle logic */ }
      this.players.delete(netId);
    }
  }

  get(netId) { return this.players.get(netId); }
  getAll() { return [...this.players.values()]; }
  count() { return this.players.size; }

  getByName(name) {
    for (const p of this.players.values())
      if (p.name.toLowerCase() === name.toLowerCase()) return p;
    return null;
  }
}

module.exports = { PlayerManager, Player };