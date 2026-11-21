const bcrypt = require('bcryptjs');

function initializeDatabase(db, adminUsername, adminPassword) {
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS applications (
      application_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      gender TEXT NOT NULL,
      city TEXT NOT NULL,
      state TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Pending'
        CHECK (status IN ('Pending', 'Approved', 'Rejected')),
      rejection_reason TEXT,
      submitted_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS certificates (
      certificate_id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL UNIQUE
        REFERENCES applications(application_id),
      issued_on TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Valid'
        CHECK (status IN ('Valid', 'Revoked'))
    );

    CREATE TABLE IF NOT EXISTS admins (
      username TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL
    );
  `);

  const passwordHash = bcrypt.hashSync(adminPassword, 12);
  db.prepare(`
    INSERT INTO admins (username, password_hash)
    VALUES (?, ?)
    ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash
  `).run(adminUsername, passwordHash);
}

module.exports = { initializeDatabase };
