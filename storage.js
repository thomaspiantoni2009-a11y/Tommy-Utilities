const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

class StorageService {
  constructor(dbPath = './data/bot.db') {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this._migrate();
    this._prepare();
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS custom_commands (
        name TEXT PRIMARY KEY,
        response TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mod_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        target_id TEXT,
        target TEXT,
        moderator TEXT,
        reason TEXT,
        duration TEXT,
        channel TEXT,
        timestamp TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_mod_logs_target ON mod_logs(target_id);

      CREATE TABLE IF NOT EXISTS blacklist (
        user_id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        reason TEXT NOT NULL,
        moderator_id TEXT NOT NULL,
        moderator_tag TEXT NOT NULL,
        added_at TEXT NOT NULL
      );
    `);
  }

  _prepare() {
    // Custom commands
    this._allCmds = this.db.prepare('SELECT name, response FROM custom_commands');
    this._getCmd = this.db.prepare('SELECT response FROM custom_commands WHERE name = ?');
    this._upsertCmd = this.db.prepare(`
      INSERT INTO custom_commands (name, response, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET response = excluded.response
    `);
    this._delCmd = this.db.prepare('DELETE FROM custom_commands WHERE name = ?');

    // Mod logs
    this._insertLog = this.db.prepare(`
      INSERT INTO mod_logs (type, target_id, target, moderator, reason, duration, channel, timestamp)
      VALUES (@type, @targetId, @target, @moderator, @reason, @duration, @channel, @timestamp)
    `);
    this._logsByTarget = this.db.prepare('SELECT * FROM mod_logs WHERE target_id = ? ORDER BY id DESC');
    this._trimLogs = this.db.prepare(`
      DELETE FROM mod_logs WHERE id NOT IN (
        SELECT id FROM mod_logs ORDER BY id DESC LIMIT 5000
      )
    `);

    // Blacklist
    this._blGet = this.db.prepare('SELECT * FROM blacklist WHERE user_id = ?');
    this._blAll = this.db.prepare('SELECT * FROM blacklist ORDER BY added_at DESC');
    this._blInsert = this.db.prepare(`
      INSERT INTO blacklist (user_id, username, reason, moderator_id, moderator_tag, added_at)
      VALUES (@userId, @username, @reason, @moderatorId, @moderatorTag, @addedAt)
    `);
    this._blDelete = this.db.prepare('DELETE FROM blacklist WHERE user_id = ?');

    this._logCounter = 0;
  }

  // ===== Custom Commands =====
  loadCommands() {
    return Object.fromEntries(this._allCmds.all().map(r => [r.name, r.response]));
  }

  getCommand(name) {
    return this._getCmd.get(name)?.response ?? null;
  }

  saveCommand(name, response) {
    this._upsertCmd.run(name, response, new Date().toISOString());
  }

  deleteCommand(name) {
    return this._delCmd.run(name).changes > 0;
  }

  // ===== Mod Logs =====
  saveLog(entry) {
    try {
      this._insertLog.run({
        type: entry.type || 'N/A',
        targetId: entry.targetId || null,
        target: entry.target || null,
        moderator: entry.moderator || null,
        reason: entry.reason || null,
        duration: entry.duration || null,
        channel: entry.channel || null,
        timestamp: new Date().toISOString()
      });
      if (++this._logCounter % 100 === 0) this._trimLogs.run();
    } catch (err) {
      console.error('❌ saveLog error:', err);
    }
  }

  getLogsForUser(userId) {
    return this._logsByTarget.all(userId);
  }

  // ===== Blacklist =====
  isBlacklisted(userId) {
    return !!this._blGet.get(userId);
  }

  getBlacklistEntry(userId) {
    return this._blGet.get(userId) || null;
  }

  getAllBlacklist() {
    return this._blAll.all();
  }

  addToBlacklist(userId, username, reason, moderatorId, moderatorTag) {
    if (this.isBlacklisted(userId)) return false;
    this._blInsert.run({
      userId, username, reason, moderatorId, moderatorTag,
      addedAt: new Date().toISOString()
    });
    return true;
  }

  removeFromBlacklist(userId) {
    return this._blDelete.run(userId).changes > 0;
  }

  close() {
    this.db.close();
  }
}

module.exports = StorageService;
