// src/fxserver/database/index.js
/**
 * Database layer - uses SQLite (better-sqlite3) if installed,
 * otherwise falls back to a JSON-file store so it works out of the box.
 *
 * In production you'd use MySQL/PostgreSQL with connection pooling.
 */
const fs = require('fs');
const path = require('path');

class Database {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.useSqlite = false;
    this.db = null;
    try {
      const Database = require('better-sqlite3');
      this.db = new Database(dbPath + '.sqlite');
      this.useSqlite = true;
      this._initSqlite();
    } catch (e) {
      console.log('[DB] better-sqlite3 not found, using JSON store');
      this.jsonPath = dbPath + '.json';
      this.data = fs.existsSync(this.jsonPath)
        ? JSON.parse(fs.readFileSync(this.jsonPath, 'utf8'))
        : { users: {}, vehicles: {}, houses: {} };
    }
  }

  _initSqlite() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        license TEXT UNIQUE,
        money INTEGER DEFAULT 5000,
        bank INTEGER DEFAULT 25000,
        position TEXT DEFAULT '{"x":0,"y":0,"z":72}',
        model TEXT DEFAULT 'mp_m_freemode_01',
        appearance TEXT DEFAULT '{}',
        inventory TEXT DEFAULT '{}',
        vehicles TEXT DEFAULT '[]',
        created INTEGER NOT NULL,
        last_seen INTEGER
      );
      CREATE TABLE IF NOT EXISTS vehicles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner INTEGER,
        model INTEGER NOT NULL,
        plate TEXT,
        props TEXT,
        stored INTEGER DEFAULT 1,
        FOREIGN KEY(owner) REFERENCES users(id)
      );
      CREATE TABLE IF NOT EXISTS houses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner INTEGER,
        x REAL, y REAL, z REAL,
        price INTEGER DEFAULT 0,
        FOREIGN KEY(owner) REFERENCES users(id)
      );
    `);
  }

  _save() {
    if (!this.useSqlite) fs.writeFileSync(this.jsonPath, JSON.stringify(this.data, null, 2));
  }

  // Users
  findOrCreateUser(name, license = null) {
    if (this.useSqlite) {
      let u = this.db.prepare('SELECT * FROM users WHERE name = ? OR license = ?')
                    .get(name, license);
      if (!u) {
        const info = this.db.prepare(
          'INSERT INTO users (name, license, created) VALUES (?, ?, ?)'
        ).run(name, license, Date.now());
        u = this.db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
      }
      return u;
    } else {
      const key = license || name;
      if (!this.data.users[key]) {
        this.data.users[key] = {
          id: Object.keys(this.data.users).length + 1,
          name, license, money: 5000, bank: 25000,
          position: { x: 0, y: 0, z: 72 },
          model: 'mp_m_freemode_01',
          appearance: {}, inventory: {}, vehicles: [],
          created: Date.now()
        };
        this._save();
      }
      this.data.users[key].last_seen = Date.now();
      return this.data.users[key];
    }
  }

  updateUser(license, fields) {
    if (this.useSqlite) {
      const sets = Object.keys(fields).map(k => `${k} = ?`).join(',');
      const vals = Object.values(fields);
      this.db.prepare(`UPDATE users SET ${sets} WHERE license = ?`).run(...vals, license);
    } else {
      const u = this.data.users[license];
      if (u) { Object.assign(u, fields); this._save(); }
    }
  }
}

module.exports = { Database };