require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createApp } = require('./app');
const { initializeDatabase } = require('./database');

const { ADMIN_USERNAME, ADMIN_PASSWORD, JWT_SECRET } = process.env;
if (!ADMIN_USERNAME || !ADMIN_PASSWORD || !JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error('Set ADMIN_USERNAME, ADMIN_PASSWORD, and a JWT_SECRET of at least 32 characters');
}

const databasePath = path.resolve(process.env.DATABASE_PATH || './data/certificates.sqlite');
fs.mkdirSync(path.dirname(databasePath), { recursive: true });

const db = new Database(databasePath);
initializeDatabase(db, ADMIN_USERNAME, ADMIN_PASSWORD);

const app = createApp({ db, jwtSecret: JWT_SECRET });
const port = Number(process.env.PORT || 3000);
const server = app.listen(port, () => {
  console.log(`Certificate API listening on port ${port}`);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
