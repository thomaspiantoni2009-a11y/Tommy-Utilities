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

      CREATE TABLE IF NOT EXISTS guild_config (
        guild_id TEXT PRIMARY KEY,
        autorole_id TEXT,
        log_channel_id TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS member_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        author_id TEXT NOT NULL,
        author_tag TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_notes_user ON member_notes(guild_id, user_id);
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
    this._countLogs = this.db.prepare('SELECT COUNT(*) as c FROM mod_logs');
    this._countByType = this.db.prepare('SELECT type, COUNT(*) as c FROM mod_logs GROUP BY type');
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
    this._blCount = this.db.prepare('SELECT COUNT(*) as c FROM blacklist');

    // Guild config
    this._getConfig = this.db.prepare('SELECT * FROM guild_config WHERE guild_id = ?');
    this._upsertConfig = this.db.prepare(`
      INSERT INTO guild_config (guild_id, autorole_id, log_channel_id, updated_at)
      VALUES (@guildId, @autoroleId, @logChannelId, @updatedAt)
      ON CONFLICT(guild_id) DO UPDATE SET
        autorole_id = COALESCE(excluded.autorole_id, autorole_id),
        log_channel_id = COALESCE(excluded.log_channel_id, log_channel_id),
        updated_at = excluded.updated_at
    `);

    // Member notes
    this._insertNote = this.db.prepare(`
      INSERT INTO member_notes (guild_id, user_id, author_id, author_tag, content, created_at)
      VALUES (@guildId, @userId, @authorId, @authorTag, @content, @createdAt)
    `);
    this._notesForUser = this.db.prepare('SELECT * FROM member_notes WHERE guild_id = ? AND user_id = ? ORDER BY id DESC');
    this._getNote = this.db.prepare('SELECT * FROM member_notes WHERE id = ? AND guild_id = ?');
    this._deleteNote = this.db.prepare('DELETE FROM member_notes WHERE id = ? AND guild_id = ?');
    this._countNotes = this.db.prepare('SELECT COUNT(*) as c FROM member_notes WHERE guild_id = ?');

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
  getStats() {
    const total = this._countLogs.get().c;
    const byType = this._countByType.all();
    const blacklist = this._blCount.get().c;
    return { total, byType, blacklist };
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

  // ===== Guild Config =====
  getGuildConfig(guildId) {
    return this._getConfig.get(guildId) || { guild_id: guildId, autorole_id: null, log_channel_id: null };
  }
  setAutorole(guildId, roleId) {
    this._upsertConfig.run({
      guildId,
      autoroleId: roleId,
      logChannelId: null,
      updatedAt: new Date().toISOString()
    });
  }
  clearAutorole(guildId) {
    const current = this.getGuildConfig(guildId);
    this._upsertConfig.run({
      guildId,
      autoroleId: null,
      logChannelId: current.log_channel_id,
      updatedAt: new Date().toISOString()
    });
  }
  setLogChannel(guildId, channelId) {
    this._upsertConfig.run({
      guildId,
      autoroleId: null,
      logChannelId: channelId,
      updatedAt: new Date().toISOString()
    });
  }

  // ===== Member Notes =====
  addNote(guildId, userId, authorId, authorTag, content) {
    const res = this._insertNote.run({
      guildId, userId, authorId, authorTag, content,
      createdAt: new Date().toISOString()
    });
    return res.lastInsertRowid;
  }
  getNotesForUser(guildId, userId) {
    return this._notesForUser.all(guildId, userId);
  }
  getNote(guildId, noteId) {
    return this._getNote.get(noteId, guildId) || null;
  }
  deleteNote(guildId, noteId) {
    return this._deleteNote.run(noteId, guildId).changes > 0;
  }
  countNotes(guildId) {
    return this._countNotes.get(guildId).c;
  }

  close() {
    this.db.close();
  }
}

module.exports = StorageService;
