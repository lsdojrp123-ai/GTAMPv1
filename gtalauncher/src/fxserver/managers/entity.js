// src/fxserver/managers/entity.js
/**
 * Entity Manager - authoritative world state.
 *
 * Every entity in the world has a server-side id, an owner (the client that
 * created it / has authority over its input), position, velocity, type, and
 * a replication scope.
 */

const nextId = (() => { let n = 1; return () => n++; })();

class Entity {
  constructor(type) {
    this.id = nextId();
    this.type = type;      // 'player' | 'vehicle' | 'ped' | 'object' | 'prop'
    this.owner = null;     // netId of owning player client
    this.pos = { x: 0, y: 0, z: 72 };
    this.rot = { x: 0, y: 0, z: 0, w: 1 };
    this.vel = { x: 0, y: 0, z: 0 };
    this.health = 100;
    this.model = 0;
    this.dimension = 0;
    this.streamingRange = 500; // meters
    this.state = new Map();    // syncable state bag
    this.spawned = false;
    this.lastUpdate = Date.now();
  }
}

class EntityManager {
  constructor() {
    this.entities = new Map();  // id -> Entity
  }

  create(type, owner = null) {
    const e = new Entity(type);
    e.owner = owner;
    this.entities.set(e.id, e);
    return e;
  }

  remove(id) {
    this.entities.delete(id);
  }

  get(id) { return this.entities.get(id); }

  getAll() { return [...this.entities.values()]; }

  getByType(type) {
    return [...this.entities.values()].filter(e => e.type === type);
  }

  getInRadius(pos, radius, dimension = 0) {
    const r2 = radius * radius;
    return [...this.entities.values()].filter(e => {
      if (e.dimension !== dimension) return false;
      const dx = e.pos.x - pos.x, dy = e.pos.y - pos.y, dz = e.pos.z - pos.z;
      return dx*dx + dy*dy + dz*dz <= r2;
    });
  }

  // Called each tick - validate movements against speed caps
  validateMovement(e, newPos, dt, maxSpeed = 85) {
    const dx = newPos.x - e.pos.x, dy = newPos.y - e.pos.y, dz = newPos.z - e.pos.z;
    const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
    const speed = dist / dt;
    if (speed > maxSpeed + 5) return false;
    // teleport detection (huge jumps)
    if (dist > 400) return false;
    return true;
  }
}

module.exports = { EntityManager, Entity };