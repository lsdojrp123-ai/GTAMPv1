// src/fxserver/managers/vehicle.js
/**
 * Vehicle Manager
 */
class VehicleManager {
  constructor(entityMgr) {
    this.em = entityMgr;
    this.vehicles = new Map();
  }

  create(model, pos, owner = null, primary = -1, secondary = -1) {
    const v = this.em.create('vehicle', owner);
    v.model = model;
    v.pos = { ...pos };
    v.state.set('primary', primary);
    v.state.set('secondary', secondary);
    v.state.set('locked', false);
    v.state.set('engine', false);
    v.state.set('health', 1000);
    v.state.set('driver', null);
    v.state.set('passengers', []);
    this.vehicles.set(v.id, v);
    v.spawned = true;
    return v;
  }

  destroy(id) {
    this.em.remove(id);
    this.vehicles.delete(id);
  }

  get(id) { return this.vehicles.get(id); }
  getAll() { return [...this.vehicles.values()]; }
}

module.exports = { VehicleManager };