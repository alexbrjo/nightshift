const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

class ProjectDB {
  constructor(projectPath) {
    this.dbPath = path.join(projectPath, '.nightshift', 'data.db');
    this.init();
  }

  init() {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(this.dbPath);
    this.createTables();
  }

  createTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS experiments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        experiment_id INTEGER,
        name TEXT NOT NULL,
        type TEXT CHECK(type IN ('inference', 'javascript')),
        config JSON,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(experiment_id) REFERENCES experiments(id)
      );
      CREATE TABLE IF NOT EXISTS samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id INTEGER,
        input_data JSON,
        rendered_prompt TEXT,
        raw_response TEXT,
        parsed_content JSON,
        metrics JSON,
        status TEXT CHECK(status IN ('pending', 'completed', 'error')),
        FOREIGN KEY(job_id) REFERENCES jobs(id)
      );
      CREATE TABLE IF NOT EXISTS collections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        schema JSON,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  query(sql, params = []) {
    return this.db.prepare(sql).all(...params);
  }

  run(sql, params = []) {
    return this.db.prepare(sql).run(...params);
  }
}

module.exports = ProjectDB;
