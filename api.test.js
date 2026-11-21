const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');
const Database = require('better-sqlite3');
const request = require('supertest');
const { createApp } = require('../src/app');
const { initializeDatabase } = require('../src/database');

const JWT_SECRET = 'test-secret-with-at-least-32-characters';

function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'elevate-api-'));
  const db = new Database(path.join(directory, 'test.sqlite'));
  initializeDatabase(db, 'test-admin', 'test-password');
  const app = createApp({ db, jwtSecret: JWT_SECRET });

  return {
    app,
    close() {
      db.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };
}

async function login(app) {
  const response = await request(app)
    .post('/api/admin/login')
    .send({ username: 'test-admin', password: 'test-password' });
  assert.equal(response.status, 200);
  return response.body.token;
}

const validApplication = {
  name: 'Asha Rao',
  phone: '+91 98765 43210',
  gender: 'Female',
  city: 'Pune',
  state: 'Maharashtra'
};

describe('certificate API', () => {
  it('serves the browser portal and interactive API documentation', async () => {
    const { app, close } = setup();
    try {
      const portal = await request(app).get('/');
      assert.equal(portal.status, 200);
      assert.match(portal.headers['content-type'], /text\/html/);
      assert.match(portal.text, /Citizen services/);

      const documentation = await request(app).get('/api-docs/');
      assert.equal(documentation.status, 200);
      assert.match(documentation.text, /Swagger UI/);

      const specification = await request(app).get('/api-docs.json');
      assert.equal(specification.status, 200);
      assert.ok(specification.body.paths['/api/admin/applications']);
    } finally {
      close();
    }
  });

  it('validates required fields and tracks a submitted application', async () => {
    const { app, close } = setup();
    try {
      const invalid = await request(app).post('/api/applications').send({ name: 'Asha' });
      assert.equal(invalid.status, 400);

      const created = await request(app).post('/api/applications').send(validApplication);
      assert.equal(created.status, 201);
      assert.match(created.body.applicationId, /^APP-/);
      assert.equal(created.body.status, 'Pending');

      const tracked = await request(app)
        .get(`/api/applications/track/${created.body.applicationId}`);
      assert.equal(tracked.status, 200);
      assert.equal(tracked.body.name, validApplication.name);
      assert.equal(tracked.body.status, 'Pending');
    } finally {
      close();
    }
  });

  it('protects admin routes, issues and verifies a certificate, then revokes only the certificate', async () => {
    const { app, close } = setup();
    try {
      const unauthorized = await request(app).get('/api/admin/applications');
      assert.equal(unauthorized.status, 401);

      const created = await request(app).post('/api/applications').send(validApplication);
      const applicationId = created.body.applicationId;
      const token = await login(app);
      const approved = await request(app)
        .patch(`/api/admin/applications/${applicationId}/approve`)
        .set('Authorization', `Bearer ${token}`);

      assert.equal(approved.status, 200);
      assert.equal(approved.body.status, 'Approved');
      const certificateId = approved.body.certificateId;
      const duplicateApproval = await request(app)
        .patch(`/api/admin/applications/${applicationId}/approve`)
        .set('Authorization', `Bearer ${token}`);
      assert.equal(duplicateApproval.status, 409);

      const verified = await request(app).get(`/api/certificates/verify/${certificateId}`);
      assert.equal(verified.status, 200);
      assert.equal(verified.body.status, 'Valid');

      const revoked = await request(app)
        .patch(`/api/admin/certificates/${certificateId}/revoke`)
        .set('Authorization', `Bearer ${token}`);
      assert.equal(revoked.status, 200);

      const revokedVerification = await request(app)
        .get(`/api/certificates/verify/${certificateId}`);
      assert.equal(revokedVerification.body.status, 'Revoked');

      const tracked = await request(app).get(`/api/applications/track/${applicationId}`);
      assert.equal(tracked.body.status, 'Approved');
    } finally {
      close();
    }
  });

  it('rejects a pending application and does not issue a certificate', async () => {
    const { app, close } = setup();
    try {
      const created = await request(app).post('/api/applications').send(validApplication);
      const token = await login(app);
      const rejected = await request(app)
        .patch(`/api/admin/applications/${created.body.applicationId}/reject`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'Incomplete information' });

      assert.equal(rejected.status, 200);
      assert.equal(rejected.body.status, 'Rejected');
      const certificates = await request(app)
        .get('/api/admin/certificates')
        .set('Authorization', `Bearer ${token}`);
      assert.deepEqual(certificates.body, []);
    } finally {
      close();
    }
  });
});
