// src/fxserver/managers/events.js
/**
 * Event Dispatcher - fully decoupled pub/sub event bus.
 *
 * FiveM uses events for everything: player joining, chat, inventory, jobs, etc.
 * Events can be targeted at:
 *   - "onServer"    : server-side handlers
 *   - "onClient"    : forwarded to one client
 *   - "onAllClients": broadcast to all connected clients
 *   - "onResource"  : target a specific resource
 */
class EventDispatcher {
  constructor() {
    this.handlers = new Map();        // event -> [ {resource, fn} ]
    this.clientHandlers = new Map();  // same but registered from client scripts (proxy)
  }

  on(name, resource, fn) {
    if (!this.handlers.has(name)) this.handlers.set(name, []);
    this.handlers.get(name).push({ resource, fn });
  }

  off(name, resource) {
    if (!this.handlers.has(name)) return;
    const arr = this.handlers.get(name).filter(h => h.resource !== resource);
    if (arr.length) this.handlers.set(name, arr); else this.handlers.delete(name);
  }

  emit(name, ...args) {
    const arr = this.handlers.get(name);
    if (!arr) return;
    for (const h of arr) {
      try { h.fn(...args); } catch (e) { console.error(`[Event] ${name} in ${h.resource}:`, e.message); }
    }
  }

  emitNet(name, target, ...args) {
    // target is a Player object (single) or -1 for all players
    const pkt = { t: 'event', name, args };
    if (target === -1) {
      // broadcast via net layer (set externally)
      if (this.broadcast) this.broadcast(pkt);
    } else if (target && target.send) {
      target.send(pkt);
    }
  }

  // Call a client event on all nearby players (interest management)
  emitNetInRange(name, pos, range, dimension, ...args) {
    if (!this.playersNear) return;
    const nearby = this.playersNear(pos, range, dimension);
    const pkt = { t: 'event', name, args };
    for (const p of nearby) p.send(pkt);
  }

  // Called from network layer when client emits an event
  handleClientEvent(player, name, args) {
    this.emit(name, player, ...args);
  }

  // Called when a resource stops
  removeForResource(resource) {
    for (const [name, arr] of this.handlers) {
      const next = arr.filter(h => h.resource !== resource);
      if (next.length !== arr.length) {
        if (next.length) this.handlers.set(name, next);
        else this.handlers.delete(name);
      }
    }
  }
}

module.exports = { EventDispatcher };