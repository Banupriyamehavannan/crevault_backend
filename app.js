const { randomUUID } = require('node:crypto');
const bcrypt = require('bcryptjs');
const express = require('express');
const jwt = require('jsonwebtoken');
const path = require('node:path');
const swaggerUi = require('swagger-ui-express');
const { openApiSpec } = require('./openapi');

function createApp({ db, jwtSecret }) {
  const app = express();
  app.use(express.json({ limit: '32kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.get('/api-docs.json', (req, res) => res.json(openApiSpec));
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openApiSpec));

  app.post('/api/applications', (req, res) => {
    const fields = ['name', 'phone', 'gender', 'city', 'state'];
    const values = {};
    const errors = [];

    for (const field of fields) {
      const value = req.body && req.body[field];
      if (typeof value !== 'string' || value.trim() === '') {
        errors.push(`${field} is required`);
      } else {
        values[field] = value.trim();
      }
    }

    if (typeof values.phone === 'string') {
      const digits = values.phone.replace(/\D/g, '');
      if (!/^[+()\d\s.-]+$/.test(values.phone) || digits.length < 7 || digits.length > 15) {
        errors.push('phone must contain between 7 and 15 digits');
      }
    }

    if (errors.length) {
      return res.status(400).json({ success: false, message: 'Invalid application', errors });
    }

    const applicationId = `APP-${randomUUID()}`;
    const submittedAt = new Date().toISOString();
    db.prepare(`
      INSERT INTO applications
        (application_id, name, phone, gender, city, state, submitted_at)
      VALUES
        (@applicationId, @name, @phone, @gender, @city, @state, @submittedAt)
    `).run({ applicationId, ...values, submittedAt });

    return res.status(201).json({
      success: true,
      message: 'Certificate application submitted',
      applicationId,
      status: 'Pending'
    });
  });

  app.get('/api/applications/track/:applicationId', (req, res) => {
    const application = db.prepare(`
      SELECT application_id AS applicationId, name, status, submitted_at AS submittedAt
      FROM applications
      WHERE application_id = ?
    `).get(req.params.applicationId);

    if (!application) {
      return res.status(404).json({ success: false, message: 'Application not found' });
    }
    return res.json(application);
  });

  app.get('/api/certificates/verify/:certificateId', (req, res) => {
    const certificate = db.prepare(`
      SELECT c.certificate_id AS certificateId, a.name, a.phone,
        c.issued_on AS issuedOn, c.status
      FROM certificates c
      JOIN applications a ON a.application_id = c.application_id
      WHERE c.certificate_id = ?
    `).get(req.params.certificateId);

    if (!certificate) {
      return res.status(404).json({ success: false, message: 'Certificate not found' });
    }
    return res.json(certificate);
  });

  app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'username and password are required'
      });
    }

    const admin = db.prepare(
      'SELECT username, password_hash AS passwordHash FROM admins WHERE username = ?'
    ).get(username.trim());
    if (!admin || !bcrypt.compareSync(password, admin.passwordHash)) {
      return res.status(401).json({ success: false, message: 'Invalid username or password' });
    }

    const token = jwt.sign({ sub: admin.username }, jwtSecret, { expiresIn: '1h' });
    return res.json({ success: true, message: 'Login successful', token });
  });

  function requireAdmin(req, res, next) {
    const authorization = req.get('authorization') || '';
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return res.status(401).json({ success: false, message: 'Admin authentication required' });
    }

    try {
      req.admin = jwt.verify(match[1], jwtSecret);
      return next();
    } catch (error) {
      if (error instanceof jwt.JsonWebTokenError || error instanceof jwt.TokenExpiredError) {
        return res.status(401).json({ success: false, message: 'Invalid or expired admin token' });
      }
      return next(error);
    }
  }

  app.get('/api/admin/applications', requireAdmin, (req, res) => {
    const applications = db.prepare(`
      SELECT application_id AS applicationId, name, phone, gender, city, state,
        status, rejection_reason AS rejectionReason, submitted_at AS submittedAt
      FROM applications
      ORDER BY submitted_at DESC
    `).all();
    return res.json(applications);
  });

  app.patch('/api/admin/applications/:applicationId/approve', requireAdmin, (req, res) => {
    const certificateId = `CERT-${randomUUID()}`;
    const issuedOn = new Date().toISOString();
    const approve = db.transaction(() => {
      const result = db.prepare(`
        UPDATE applications SET status = 'Approved'
        WHERE application_id = ? AND status = 'Pending'
      `).run(req.params.applicationId);
      if (result.changes === 0) return false;
      db.prepare(`
        INSERT INTO certificates (certificate_id, application_id, issued_on)
        VALUES (?, ?, ?)
      `).run(certificateId, req.params.applicationId, issuedOn);
      return true;
    });
    if (!approve()) {
      const application = db.prepare(
        'SELECT status FROM applications WHERE application_id = ?'
      ).get(req.params.applicationId);
      if (!application) {
        return res.status(404).json({ success: false, message: 'Application not found' });
      }
      return res.status(409).json({
        success: false,
        message: `Application is already ${application.status.toLowerCase()}`
      });
    }

    return res.json({
      success: true,
      message: 'Application approved',
      applicationId: req.params.applicationId,
      status: 'Approved',
      certificateId
    });
  });

  app.patch('/api/admin/applications/:applicationId/reject', requireAdmin, (req, res) => {
    const reason = req.body && req.body.reason;
    if (reason !== undefined && (typeof reason !== 'string' || reason.length > 1000)) {
      return res.status(400).json({ success: false, message: 'reason must be a string up to 1000 characters' });
    }
    const result = db.prepare(`
      UPDATE applications
      SET status = 'Rejected', rejection_reason = ?
      WHERE application_id = ? AND status = 'Pending'
    `).run(reason ? reason.trim() : null, req.params.applicationId);
    if (result.changes === 0) {
      const application = db.prepare(
        'SELECT status FROM applications WHERE application_id = ?'
      ).get(req.params.applicationId);
      if (!application) {
        return res.status(404).json({ success: false, message: 'Application not found' });
      }
      return res.status(409).json({
        success: false,
        message: `Application is already ${application.status.toLowerCase()}`
      });
    }

    return res.json({
      success: true,
      message: 'Application rejected',
      applicationId: req.params.applicationId,
      status: 'Rejected'
    });
  });

  app.get('/api/admin/certificates', requireAdmin, (req, res) => {
    const certificates = db.prepare(`
      SELECT c.certificate_id AS certificateId,
        c.application_id AS applicationId, a.name, a.phone,
        c.issued_on AS issuedOn, c.status
      FROM certificates c
      JOIN applications a ON a.application_id = c.application_id
      ORDER BY c.issued_on DESC
    `).all();
    return res.json(certificates);
  });

  function revokeCertificate(req, res) {
    const result = db.prepare(`
      UPDATE certificates SET status = 'Revoked'
      WHERE certificate_id = ? AND status = 'Valid'
    `).run(req.params.certificateId);

    if (result.changes === 0) {
      const certificate = db.prepare(
        'SELECT status FROM certificates WHERE certificate_id = ?'
      ).get(req.params.certificateId);
      if (!certificate) {
        return res.status(404).json({ success: false, message: 'Certificate not found' });
      }
      return res.status(409).json({ success: false, message: 'Certificate is already revoked' });
    }

    return res.json({
      success: true,
      message: 'Certificate revoked',
      certificateId: req.params.certificateId,
      status: 'Revoked'
    });
  }

  app.get('/api/admin/certificates/:certificateId/revoke', requireAdmin, revokeCertificate);
  app.patch('/api/admin/certificates/:certificateId/revoke', requireAdmin, revokeCertificate);

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
      return res.status(400).json({ success: false, message: 'Request body must be valid JSON' });
    }
    console.error(err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  });

  return app;
}

module.exports = { createApp };
