require('dotenv').config();
const crypto = require('node:crypto');
const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');

let compression = null;
try {
  compression = require('compression');
} catch {
  compression = null;
}

let helmet = null;
try {
  helmet = require('helmet');
} catch {
  helmet = null;
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// ============================================================================
// Security Allowlists & Input Sanitization
// ============================================================================
const ALLOWED_SYNC_KEYS = new Set([
  'farhangian_dorm_settings_prod',
  'farhangian_dorm_dormitories_prod',
  'farhangian_dorm_rooms_prod',
  'farhangian_dorm_beds_prod',
  'farhangian_dorm_students_prod',
  'farhangian_dorm_supervisors_prod',
  'farhangian_dorm_warnings_prod',
  'farhangian_dorm_announcements_prod',
  'farhangian_dorm_messages_prod',
  'farhangian_dorm_maintenance_staff_prod',
  'farhangian_dorm_maintenance_tasks_prod',
  'farhangian_dorm_warehouse_staff_prod',
  'farhangian_dorm_finance_staff_prod',
  'farhangian_dorm_procurement_staff_prod',
  'farhangian_dorm_education_staff_prod',
  'farhangian_dorm_academic_notices_prod',
  'farhangian_dorm_student_finances_prod',
  'farhangian_dorm_inventory_items_prod',
  'farhangian_dorm_inventory_transactions_prod',
  'farhangian_dorm_warehouse_requests_prod',
  'farhangian_dorm_procurement_requests_prod',
  'farhangian_dorm_shift_schedules_prod',
  'farhangian_dorm_shift_reports_prod',
  'farhangian_dorm_counselors_prod',
  'farhangian_dorm_counselor_shifts_prod',
  'farhangian_dorm_counselor_reports_prod',
  'farhangian_dorm_activity_logs_prod',
  'farhangian_dorm_student_evaluations_prod',
  'farhangian_dorm_guest_requests_prod',
  'farhangian_dorm_visit_reports_prod',
  'farhangian_dorm_surveys_prod',
  'farhangian_dorm_survey_responses_prod',
  'farhangian_dorm_cultural_staff_prod',
  'farhangian_dorm_cultural_programs_prod',
  'farhangian_dorm_cultural_associations_prod',
  'farhangian_dorm_association_memberships_prod',
  'farhangian_dorm_student_affairs_staff_prod',
  'farhangian_dorm_guild_elections_prod',
  'farhangian_dorm_guild_election_votes_prod',
  'farhangian_dorm_disciplinary_referrals_prod',
  'farhangian_dorm_sports_programs_prod',
  'farhangian_dorm_sports_registrations_prod',
  'farhangian_dorm_security_staff_prod',
  'farhangian_dorm_security_reports_prod',
  'farhangian_dorm_vice_dean_staff_prod',
]);

const ALLOWED_PHOTO_ROLES = new Set([
  'student',
  'supervisor',
  'maintenance',
  'warehouse',
  'counselor',
  'finance',
  'procurement',
  'education',
  'cultural',
  'student_affairs',
  'security',
  'vice_dean',
]);

const MAX_PHOTO_BYTES = 2 * 1024 * 1024; // 2MB per avatar/photo
const DISALLOWED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function sanitizePayload(value, depth = 0) {
  if (depth > 32 || value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizePayload(item, depth + 1));
  }
  const clean = {};
  for (const [k, v] of Object.entries(value)) {
    if (DISALLOWED_KEYS.has(k) || k.startsWith('$') || k.includes('\0')) continue;
    clean[k] = sanitizePayload(v, depth + 1);
  }
  return clean;
}

// ============================================================================
// Middlewares: CORS (Preflight First), Security Headers, Compression, JSON
// ============================================================================
const rawAllowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim().replace(/\/+$/, ''))
  .filter(Boolean);

const corsOptions = {
  origin(origin, callback) {
    if (!origin || rawAllowedOrigins.length === 0 || rawAllowedOrigins.includes('*')) {
      return callback(null, true);
    }
    const cleanOrigin = String(origin).trim().replace(/\/+$/, '');
    if (rawAllowedOrigins.includes(cleanOrigin)) {
      return callback(null, true);
    }
    return callback(new Error('Origin not allowed by CORS policy'));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'If-None-Match',
    'X-Sync-Token',
    'Cache-Control',
    'Pragma',
  ],
  exposedHeaders: ['ETag'],
  maxAge: 86400,
};

app.use(cors(corsOptions));

if (helmet) {
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      crossOriginEmbedderPolicy: false,
      crossOriginOpenerPolicy: false,
      contentSecurityPolicy: false,
    })
  );
} else {
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });
}

if (compression) {
  app.use(compression({ threshold: 512 }));
}

app.use(express.json({ limit: '5mb' }));

// Sliding-window in-memory rate limiter (bounded Map, ignores OPTIONS preflight)
const rateBuckets = new Map();
function createRateLimiter({ windowMs, maxRequests, keyPrefix }) {
  return (req, res, next) => {
    if (req.method === 'OPTIONS') return next();
    const forwarded = req.headers['x-forwarded-for'];
    const ip =
      (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : '') ||
      req.ip ||
      'unknown';
    const bucketKey = `${keyPrefix}:${ip}`;
    const now = Date.now();
    const existing = rateBuckets.get(bucketKey);

    if (!existing || now - existing.windowStart >= windowMs) {
      if (rateBuckets.size > 5000) {
        for (const [k, v] of rateBuckets.entries()) {
          if (now - v.windowStart >= windowMs) rateBuckets.delete(k);
        }
      }
      rateBuckets.set(bucketKey, { windowStart: now, count: 1 });
      return next();
    }

    existing.count += 1;
    if (existing.count > maxRequests) {
      return res.status(429).json({
        ok: false,
        message: 'تعداد درخواست‌ها بیش از حد مجاز است. لطفاً چند لحظه بعد تلاش نمایید.',
      });
    }
    return next();
  };
}

const readLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 500, keyPrefix: 'r' });
const writeLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 500, keyPrefix: 'w' });
const aiLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 25, keyPrefix: 'ai' });

function requireSyncTokenIfConfigured(req, res, next) {
  const configuredToken = (process.env.CLOUD_SYNC_API_TOKEN || '').trim();
  if (!configuredToken) return next();

  const authHeader = String(req.headers.authorization || '');
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const altToken = String(req.headers['x-sync-token'] || '').trim();
  const provided = bearerToken || altToken;

  if (!provided) {
    return res.status(401).json({ ok: false, message: 'Unauthorized' });
  }
  const a = Buffer.from(provided);
  const b = Buffer.from(configuredToken);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(403).json({ ok: false, message: 'Forbidden' });
  }
  return next();
}

// ============================================================================
// Serverless-Optimized MongoDB Atlas Connection & Auto DB Name Resolution
// ============================================================================
function extractDbNameFromUri(uri) {
  try {
    if (!uri) return '';
    const cleaned = uri.replace(/^mongodb(\+srv)?:\/\//i, 'https://');
    const parsed = new URL(cleaned);
    const dbPart = decodeURIComponent(parsed.pathname || '').replace(/^\/+|\/+$/g, '');
    return dbPart;
  } catch {
    return '';
  }
}

async function resolveDatabase(client) {
  if (globalThis._khabgahResolvedDbName) {
    return client.db(globalThis._khabgahResolvedDbName);
  }

  const explicitEnvDb = (process.env.MONGODB_DB_NAME || '').trim();
  if (explicitEnvDb) {
    globalThis._khabgahResolvedDbName = explicitEnvDb;
    return client.db(explicitEnvDb);
  }

  const uriDb = extractDbNameFromUri((process.env.MONGODB_URI || '').trim());
  const candidates = [];
  if (uriDb) candidates.push(uriDb);
  if (!candidates.includes('khabgah_db')) candidates.push('khabgah_db');
  if (!candidates.includes('test')) candidates.push('test');

  for (const name of candidates) {
    try {
      const candidateDb = client.db(name);
      const [kvCount, stCount] = await Promise.all([
        candidateDb.collection('sync_kv').estimatedDocumentCount().catch(() => 0),
        candidateDb.collection('students').estimatedDocumentCount().catch(() => 0),
      ]);
      if (kvCount > 0 || stCount > 0) {
        globalThis._khabgahResolvedDbName = name;
        return candidateDb;
      }
    } catch {
      // continue checking next candidate
    }
  }

  const defaultDbName = uriDb || 'khabgah_db';
  globalThis._khabgahResolvedDbName = defaultDbName;
  return client.db(defaultDbName);
}

async function getDb() {
  const mongoUri = (process.env.MONGODB_URI || '').trim();
  if (!mongoUri) {
    const err = new Error('MONGODB_URI is not configured');
    err.code = 'MONGODB_URI_MISSING';
    throw err;
  }

  if (!globalThis._khabgahMongoPromise) {
    const client = new MongoClient(mongoUri, {
      maxPoolSize: 5,
      minPoolSize: 0,
      maxIdleTimeMS: 30_000,
      connectTimeoutMS: 12_000,
      serverSelectionTimeoutMS: 12_000,
      socketTimeoutMS: 45_000,
    });
    globalThis._khabgahMongoPromise = client.connect().catch((err) => {
      globalThis._khabgahMongoPromise = null;
      throw err;
    });
  }

  let connectedClient;
  try {
    connectedClient = await globalThis._khabgahMongoPromise;
  } catch (err) {
    globalThis._khabgahMongoPromise = null;
    throw err;
  }

  const db = await resolveDatabase(connectedClient);

  if (!globalThis._khabgahIndexesPromise) {
    globalThis._khabgahIndexesPromise = Promise.all([
      db.collection('sync_kv').createIndex({ key: 1 }, { unique: true }),
      db.collection('students').createIndex({ studentId: 1 }, { unique: true }),
      db.collection('photos').createIndex({ role: 1, userId: 1 }, { unique: true }),
      db.collection('sync_meta').createIndex({ id: 1 }, { unique: true }),
    ]).catch((err) => {
      console.warn('Mongo index initialization warning:', err && err.message);
      globalThis._khabgahIndexesPromise = null;
    });
  }
  await globalThis._khabgahIndexesPromise;

  return db;
}

async function bumpGlobalRevision(db) {
  const result = await db.collection('sync_meta').findOneAndUpdate(
    { id: 'global' },
    {
      $inc: { revision: 1 },
      $set: { updatedAt: new Date().toISOString() },
    },
    { upsert: true, returnDocument: 'after' }
  );
  return (result && result.revision) || (result && result.value && result.value.revision) || Date.now();
}

async function getGlobalMeta(db) {
  const meta = await db
    .collection('sync_meta')
    .findOne({ id: 'global' }, { projection: { _id: 0, revision: 1, updatedAt: 1 } });
  return {
    revision: (meta && meta.revision) ?? 0,
    updatedAt: (meta && meta.updatedAt) ?? null,
  };
}

function makeWeakEtag(raw) {
  const digest = crypto.createHash('sha256').update(String(raw)).digest('base64url').slice(0, 24);
  return `"${digest}"`;
}

// ============================================================================
// Root, Health & Version Endpoints
// ============================================================================
app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'khabgah-api',
    status: 'running',
    health: '/api/health',
  });
});

app.get('/api', (_req, res) => {
  res.json({
    ok: true,
    service: 'khabgah-api',
    status: 'running',
    health: '/api/health',
  });
});

app.get('/api/health', readLimiter, async (_req, res) => {
  try {
    const db = await getDb();
    await db.command({ ping: 1 });
    const [syncKv, students, photos] = await Promise.all([
      db.collection('sync_kv').countDocuments({}).catch(() => 0),
      db.collection('students').countDocuments({}).catch(() => 0),
      db.collection('photos').countDocuments({}).catch(() => 0),
    ]);
    res.set('Cache-Control', 'no-store');
    return res.json({
      ok: true,
      status: 'healthy',
      dbName: db.databaseName,
      counts: { syncKv, students, photos },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    const code = err && err.code === 'MONGODB_URI_MISSING' ? 'MONGODB_URI_MISSING' : 'DB_UNAVAILABLE';
    return res.status(503).json({
      ok: false,
      status: 'unavailable',
      code,
      message:
        code === 'MONGODB_URI_MISSING'
          ? 'متغیر محیطی MONGODB_URI در تنظیمات سرور Vercel تعریف نشده است.'
          : 'عدم امکان برقراری ارتباط با پایگاه داده MongoDB Atlas.',
    });
  }
});

app.get('/api/sync/version', readLimiter, async (_req, res) => {
  try {
    const db = await getDb();
    const meta = await getGlobalMeta(db);
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, revision: meta.revision, updatedAt: meta.updatedAt });
  } catch {
    return res.status(500).json({ ok: false, message: 'خطا در بررسی نسخه سرور' });
  }
});

// ============================================================================
// Sync Endpoints (Manifest, Chunked GET ?keys=, Full GET, POST single/batch)
// ============================================================================
app.get('/api/sync/manifest', readLimiter, async (_req, res) => {
  try {
    const db = await getDb();
    const [meta, docs] = await Promise.all([
      getGlobalMeta(db),
      db
        .collection('sync_kv')
        .aggregate([
          {
            $project: {
              _id: 0,
              key: 1,
              updatedAt: 1,
              sizeBytes: { $bsonSize: { $ifNull: ['$value', ''] } },
            },
          },
        ])
        .toArray()
        .catch(() =>
          db
            .collection('sync_kv')
            .find({}, { projection: { _id: 0, key: 1, updatedAt: 1 } })
            .toArray()
        ),
    ]);

    const keys = docs
      .filter((d) => d && typeof d.key === 'string' && ALLOWED_SYNC_KEYS.has(d.key))
      .map((d) => ({
        key: d.key,
        updatedAt: d.updatedAt || null,
        sizeBytes: typeof d.sizeBytes === 'number' ? d.sizeBytes : null,
      }));

    res.set('Cache-Control', 'no-store');
    return res.json({
      ok: true,
      revision: meta.revision,
      updatedAt: meta.updatedAt,
      keys,
    });
  } catch (err) {
    console.error('GET /api/sync/manifest error:', err && err.message);
    return res.status(500).json({ ok: false, message: 'خطا در دریافت فهرست کلیدهای همگام‌سازی' });
  }
});

app.get('/api/sync', readLimiter, async (req, res) => {
  try {
    const db = await getDb();
    const rawKeysParam = typeof req.query.keys === 'string' ? req.query.keys.trim() : '';
    const requestedKeys = rawKeysParam
      ? rawKeysParam
          .split(',')
          .map((s) => s.trim())
          .filter((k) => k && ALLOWED_SYNC_KEYS.has(k))
      : null;

    const filter =
      requestedKeys && requestedKeys.length > 0 ? { key: { $in: requestedKeys } } : {};

    const [meta, docs] = await Promise.all([
      getGlobalMeta(db),
      db
        .collection('sync_kv')
        .find(filter, { projection: { _id: 0, key: 1, value: 1, updatedAt: 1 } })
        .toArray(),
    ]);

    let latestUpdatedAt = '';
    const kvMap = {};
    for (const doc of docs) {
      if (doc && typeof doc.key === 'string' && ALLOWED_SYNC_KEYS.has(doc.key)) {
        kvMap[doc.key] = doc.value;
        if (typeof doc.updatedAt === 'string' && doc.updatedAt > latestUpdatedAt) {
          latestUpdatedAt = doc.updatedAt;
        }
      }
    }

    if (!requestedKeys) {
      const etag = makeWeakEtag(`sync:${meta.revision}:${docs.length}:${latestUpdatedAt}`);
      res.set('ETag', etag);
      res.set('Cache-Control', 'private, no-cache');
      if (req.headers['if-none-match'] && req.headers['if-none-match'] === etag) {
        return res.status(304).end();
      }
    } else {
      res.set('Cache-Control', 'no-store');
    }

    return res.json(kvMap);
  } catch (err) {
    console.error('GET /api/sync error:', err && err.message);
    return res.status(500).json({ ok: false, message: 'خطا در دریافت داده‌های همگام‌سازی' });
  }
});

app.post('/api/sync', writeLimiter, requireSyncTokenIfConfigured, async (req, res) => {
  try {
    const { key, value } = req.body || {};
    if (typeof key !== 'string' || !ALLOWED_SYNC_KEYS.has(key)) {
      return res.status(400).json({ ok: false, message: 'کلید ذخیره‌سازی نامعتبر است.' });
    }
    if (value === undefined) {
      return res.status(400).json({ ok: false, message: 'مقدار ارسالی نامعتبر است.' });
    }

    const cleanValue = sanitizePayload(value);
    const db = await getDb();
    const nowIso = new Date().toISOString();

    await db.collection('sync_kv').updateOne(
      { key },
      { $set: { key, value: cleanValue, updatedAt: nowIso } },
      { upsert: true }
    );

    const revision = await bumpGlobalRevision(db);
    return res.json({ ok: true, key, revision });
  } catch (err) {
    console.error('POST /api/sync error:', err && err.message);
    return res.status(500).json({ ok: false, message: 'خطا در ذخیره‌سازی داده در پایگاه داده' });
  }
});

app.post('/api/sync/batch', writeLimiter, requireSyncTokenIfConfigured, async (req, res) => {
  try {
    const entries = req.body && req.body.entries;
    if (!Array.isArray(entries) || entries.length === 0 || entries.length > 60) {
      return res.status(400).json({ ok: false, message: 'فهرست دسته‌ای همگام‌سازی نامعتبر است.' });
    }

    const nowIso = new Date().toISOString();
    const ops = [];
    for (const entry of entries) {
      if (!entry || typeof entry.key !== 'string' || !ALLOWED_SYNC_KEYS.has(entry.key)) {
        return res.status(400).json({ ok: false, message: 'یکی از کلیدهای ارسالی مجاز نیست.' });
      }
      if (entry.value === undefined) continue;
      ops.push({
        updateOne: {
          filter: { key: entry.key },
          update: {
            $set: {
              key: entry.key,
              value: sanitizePayload(entry.value),
              updatedAt: nowIso,
            },
          },
          upsert: true,
        },
      });
    }

    if (ops.length === 0) {
      return res.json({ ok: true, count: 0 });
    }

    const db = await getDb();
    await db.collection('sync_kv').bulkWrite(ops, { ordered: false });
    const revision = await bumpGlobalRevision(db);

    return res.json({ ok: true, count: ops.length, revision });
  } catch (err) {
    console.error('POST /api/sync/batch error:', err && err.message);
    return res.status(500).json({ ok: false, message: 'خطا در ذخیره‌سازی دسته‌ای داده‌ها' });
  }
});

// ============================================================================
// Dedicated Students Endpoints (Compatible with Legacy + New Payloads)
// ============================================================================
app.get('/api/students', readLimiter, async (req, res) => {
  try {
    const db = await getDb();
    const hasPagination = req.query.limit !== undefined || req.query.skip !== undefined;

    if (hasPagination) {
      const skip = Math.max(0, Number.parseInt(String(req.query.skip || '0'), 10) || 0);
      const rawLimit = Number.parseInt(String(req.query.limit || '400'), 10) || 400;
      const limit = Math.min(Math.max(rawLimit, 1), 800);

      const [total, students] = await Promise.all([
        db.collection('students').countDocuments({}),
        db
          .collection('students')
          .find({}, { projection: { _id: 0 } })
          .sort({ studentId: 1 })
          .skip(skip)
          .limit(limit)
          .toArray(),
      ]);

      const nextSkip = skip + students.length;
      res.set('Cache-Control', 'no-store');
      return res.json({
        ok: true,
        total,
        skip,
        limit,
        hasMore: nextSkip < total && students.length > 0,
        nextSkip,
        students,
      });
    }

    const [meta, students] = await Promise.all([
      getGlobalMeta(db),
      db
        .collection('students')
        .find({}, { projection: { _id: 0 } })
        .toArray(),
    ]);

    let latestUpdatedAt = '';
    for (const s of students) {
      if (s && typeof s.updatedAt === 'string' && s.updatedAt > latestUpdatedAt) {
        latestUpdatedAt = s.updatedAt;
      }
    }

    const etag = makeWeakEtag(`students:${meta.revision}:${students.length}:${latestUpdatedAt}`);
    res.set('ETag', etag);
    res.set('Cache-Control', 'private, no-cache');

    if (req.headers['if-none-match'] && req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }

    return res.json(students);
  } catch (err) {
    console.error('GET /api/students error:', err && err.message);
    return res.status(500).json({ ok: false, message: 'خطا در دریافت فهرست دانشجویان' });
  }
});

app.post('/api/students', writeLimiter, requireSyncTokenIfConfigured, async (req, res) => {
  try {
    const body = sanitizePayload(req.body || {});
    const listInput = Array.isArray(body && body.students)
      ? body.students
      : body && body.student && typeof body.student === 'object'
      ? [body.student]
      : body && body.studentId
      ? [body]
      : [];

    if (listInput.length === 0) {
      return res.status(400).json({ ok: false, message: 'اطلاعات دانشجو نامعتبر است.' });
    }

    const nowIso = new Date().toISOString();
    const ops = [];
    const validIds = new Set();
    let firstValid = null;

    for (const rawStudent of listInput) {
      if (!rawStudent || !rawStudent.studentId) continue;
      const studentId = String(rawStudent.studentId).trim();
      if (!studentId || studentId.length > 64) continue;
      validIds.add(studentId);
      const { _id, __v, ...cleanFields } = rawStudent;
      void _id;
      void __v;
      const doc = { ...cleanFields, studentId, updatedAt: nowIso };
      if (!firstValid) firstValid = doc;
      ops.push({
        updateOne: {
          filter: { studentId },
          update: { $set: doc },
          upsert: true,
        },
      });
    }

    if (ops.length === 0) {
      return res.status(400).json({ ok: false, message: 'شماره دانشجویی معتبر یافت نشد.' });
    }

    const db = await getDb();
    await db.collection('students').bulkWrite(ops, { ordered: false });
    if (body && body.replaceAll === true && validIds.size > 0) {
      await db.collection('students').deleteMany({ studentId: { $nin: Array.from(validIds) } });
    } else if (body && Array.isArray(body.keepStudentIds) && body.keepStudentIds.length > 0) {
      const keepIds = body.keepStudentIds.map((id) => String(id || '').trim()).filter(Boolean);
      if (keepIds.length > 0) {
        await db.collection('students').deleteMany({ studentId: { $nin: keepIds } });
      }
    }
    const revision = await bumpGlobalRevision(db);

    return res.json({
      ok: true,
      count: ops.length,
      student: firstValid,
      revision,
      message: 'اطلاعات دانشجو با موفقیت در پایگاه داده ثبت شد.',
    });
  } catch (err) {
    console.error('POST /api/students error:', err && err.message);
    return res.status(500).json({ ok: false, message: 'خطا در ثبت اطلاعات دانشجو' });
  }
});

app.delete('/api/students/:studentId', writeLimiter, requireSyncTokenIfConfigured, async (req, res) => {
  try {
    const studentId = String(req.params.studentId || '').trim();
    if (!studentId || studentId.length > 64) {
      return res.status(400).json({ ok: false, message: 'شناسه دانشجو نامعتبر است.' });
    }

    const db = await getDb();
    await db.collection('students').deleteOne({ studentId });
    const revision = await bumpGlobalRevision(db);
    return res.json({ ok: true, revision });
  } catch (err) {
    console.error('DELETE /api/students/:studentId error:', err && err.message);
    return res.status(500).json({ ok: false, message: 'خطا در حذف پرونده دانشجو' });
  }
});

// ============================================================================
// Avatar / Profile Photo Endpoints (Binary Storage, Batch Upload & Paginated Export)
// ============================================================================
app.post('/api/photos/batch', writeLimiter, requireSyncTokenIfConfigured, async (req, res) => {
  try {
    const items = req.body && req.body.items;
    if (!Array.isArray(items) || items.length === 0 || items.length > 30) {
      return res.status(400).json({ ok: false, message: 'فهرست تصاویر ارسالی نامعتبر است.' });
    }

    const publicBase = (process.env.PUBLIC_API_BASE_URL || '').trim().replace(/\/+$/, '');
    const inferredBase = publicBase || `${req.protocol}://${req.get('host')}/api`;
    const nowTs = Date.now();
    const ops = [];
    const urls = {};

    for (const item of items) {
      const role = String((item && item.role) || '').trim();
      const userId = String((item && item.userId) || '').trim();
      const dataUrl = String((item && item.dataUrl) || '').trim();

      if (!ALLOWED_PHOTO_ROLES.has(role) || !userId || userId.length > 100) {
        return res.status(400).json({ ok: false, message: 'نقش یا شناسه کاربر برای بارگذاری تصویر نامعتبر است.' });
      }

      const match = dataUrl.match(/^data:image\/(jpeg|jpg|png|webp|gif);base64,([A-Za-z0-9+/=]+)$/i);
      if (!match) {
        return res.status(400).json({
          ok: false,
          message: 'فرمت تصویر مجاز نیست. صرفاً تصاویر JPG، PNG، WebP و GIF مجاز هستند.',
        });
      }

      const ext = match[1].toLowerCase() === 'jpg' ? 'jpeg' : match[1].toLowerCase();
      const mimeType = `image/${ext}`;
      const buffer = Buffer.from(match[2], 'base64');

      if (buffer.length === 0 || buffer.length > MAX_PHOTO_BYTES) {
        return res.status(413).json({
          ok: false,
          message: 'حجم تصویر بیش از سقف مجاز (۲ مگابایت) است.',
        });
      }

      const etag = makeWeakEtag(buffer);
      ops.push({
        updateOne: {
          filter: { role, userId },
          update: {
            $set: {
              role,
              userId,
              mimeType,
              data: buffer,
              etag,
              updatedAt: new Date().toISOString(),
            },
          },
          upsert: true,
        },
      });

      urls[userId] = `${inferredBase}/photo/${encodeURIComponent(role)}/${encodeURIComponent(userId)}?v=${nowTs}`;
    }

    const db = await getDb();
    await db.collection('photos').bulkWrite(ops, { ordered: false });

    return res.json({ ok: true, count: ops.length, urls });
  } catch (err) {
    console.error('POST /api/photos/batch error:', err && err.message);
    return res.status(500).json({ ok: false, message: 'خطا در ذخیره‌سازی ابری تصاویر' });
  }
});

app.get('/api/photos/export', readLimiter, async (req, res) => {
  try {
    const skip = Math.max(0, Number.parseInt(String(req.query.skip || '0'), 10) || 0);
    const rawLimit = Number.parseInt(String(req.query.limit || '30'), 10) || 30;
    const limit = Math.min(Math.max(rawLimit, 1), 50);
    const MAX_RESPONSE_BYTES = 2_800_000;

    const db = await getDb();
    const total = await db.collection('photos').countDocuments({});
    const docs = await db
      .collection('photos')
      .find({}, { projection: { _id: 0, role: 1, userId: 1, mimeType: 1, data: 1, updatedAt: 1 } })
      .sort({ role: 1, userId: 1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    const photos = [];
    let accumulatedBytes = 0;
    let processedCount = 0;

    for (const doc of docs) {
      if (!doc || !doc.role || !doc.userId || !doc.data) {
        processedCount += 1;
        continue;
      }
      const buffer = Buffer.isBuffer(doc.data)
        ? doc.data
        : Buffer.from(doc.data.buffer || doc.data);
      const safeMime =
        typeof doc.mimeType === 'string' && /^image\/(jpeg|png|webp|gif)$/i.test(doc.mimeType)
          ? doc.mimeType
          : 'image/jpeg';
      const dataUrl = `data:${safeMime};base64,${buffer.toString('base64')}`;

      if (photos.length > 0 && accumulatedBytes + dataUrl.length > MAX_RESPONSE_BYTES) {
        break;
      }

      photos.push({
        role: String(doc.role),
        userId: String(doc.userId),
        mimeType: safeMime,
        dataUrl,
        updatedAt: doc.updatedAt || null,
      });
      accumulatedBytes += dataUrl.length;
      processedCount += 1;
    }

    const nextSkip = skip + processedCount;
    res.set('Cache-Control', 'no-store');
    return res.json({
      ok: true,
      total,
      skip,
      limit,
      hasMore: nextSkip < total && processedCount > 0,
      nextSkip,
      photos,
    });
  } catch (err) {
    console.error('GET /api/photos/export error:', err && err.message);
    return res.status(500).json({ ok: false, message: 'خطا در استخراج فایل‌های تصویری از سرور' });
  }
});

app.get('/api/photo/:role/:userId', readLimiter, async (req, res) => {
  try {
    const role = String(req.params.role || '').trim();
    const userId = String(req.params.userId || '').trim();
    if (!ALLOWED_PHOTO_ROLES.has(role) || !userId || userId.length > 100) {
      return res.status(400).end();
    }

    const db = await getDb();
    const doc = await db.collection('photos').findOne({ role, userId });
    if (!doc || !doc.data) {
      return res.status(404).end();
    }

    const buffer = Buffer.isBuffer(doc.data) ? doc.data : Buffer.from(doc.data.buffer || doc.data);
    const etag = doc.etag || makeWeakEtag(buffer);
    const safeMime =
      typeof doc.mimeType === 'string' && /^image\/(jpeg|png|webp|gif)$/i.test(doc.mimeType)
        ? doc.mimeType
        : 'image/jpeg';

    res.set('ETag', etag);
    res.set('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
    res.set('X-Content-Type-Options', 'nosniff');
    res.type(safeMime);

    if (req.headers['if-none-match'] && req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }

    return res.send(buffer);
  } catch (err) {
    console.error('GET /api/photo/:role/:userId error:', err && err.message);
    return res.status(500).end();
  }
});

// ============================================================================
// Optional Server-Side Gemini Assistant Proxy
// ============================================================================
app.post('/api/ai-chat', async (req, res) => {
  try {
    const { message, publicContext, studentInfo } = req.body || {};
    const apiKey = (process.env.GROQ_API_KEY || process.env.GEMINI_API_KEY || '').trim();

    if (!apiKey) {
      return res.status(500).json({ 
        ok: false,
        reply: 'کلید API در تنظیمات سرور (Vercel Environment Variables) یافت نشد.' 
      });
    }

    // خلاصه‌سازی داده‌ها برای جلوگیری از خطای طولانی بودن پیام
    const cleanAndTruncate = (obj, maxLength = 2500) => {
      if (!obj) return '';
      try {
        const str = typeof obj === 'string' ? obj : JSON.stringify(obj, (key, value) => {
          if (typeof value === 'string' && (value.startsWith('data:image') || value.length > 500)) {
            return '[تصویر/متن طولانی حذف شد]';
          }
          return value;
        });
        return str.length > maxLength ? str.substring(0, maxLength) + '... [خلاصه شده]' : str;
      } catch (e) {
        return '';
      }
    };

    const safeContext = cleanAndTruncate(publicContext, 2500);
    const safeStudent = cleanAndTruncate(studentInfo, 800);
    const safeMessage = String(message || 'سلام').substring(0, 1000);

    const systemInstruction = `
تو دستیار هوشمند رسمی «سامانه اسکان و امور سراهای دانشجویی دانشگاه فرهنگیان اصفهان» هستی.
به سوالات دانشجویان درباره اطلاعات سراها، اطلاعیه‌ها، مسائل خوابگاهی و آموزشی به زبان فارسی روان و محترمانه پاسخ بده.
خط قرمز امنیتی: هرگز اطلاعات شخصی و حساس (کد ملی، شماره تماس، رمز عبور، آدرس و محل اسکان سایر افراد) را فاش نکن.

خلاصه اطلاعات سامانه:
${safeContext}

اطلاعات کاربر فعلی:
${safeStudent || 'کاربر مهمان'}
`.trim();

    // دریافت لیست مدل‌های فعال اکانت Groq
    let candidateModels = [
      'meta-llama/llama-4-scout-17b-16e-instruct',
      'meta-llama/llama-4-maverick-17b-128e-instruct',
      'llama-3.1-8b-instant',
      'qwen-qwq-32b',
      'gemma2-9b-it'
    ];

    try {
      const modelsRes = await fetch('https://api.groq.com/openai/v1/models', {
        headers: { 'Authorization': `Bearer ${apiKey}` }
      });
      if (modelsRes.ok) {
        const modelsData = await modelsRes.json();
        const availableIds = (modelsData.data || [])
          .map(m => m.id)
          .filter(id => 
            !id.includes('whisper') && 
            !id.includes('tts') && 
            !id.includes('guard') && 
            !id.includes('allam') &&
            !id.includes('vision')
          );

        const prioritized = candidateModels.filter(m => availableIds.includes(m));
        const others = availableIds.filter(m => !prioritized.includes(m));
        if (prioritized.length > 0 || others.length > 0) {
          candidateModels = [...prioritized, ...others];
        }
      }
    } catch (e) {
      console.error('Error fetching models:', e);
    }

    let lastError = 'مدلی یافت نشد';
    for (const modelName of candidateModels.slice(0, 4)) {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: modelName,
          messages: [
            { role: 'system', content: systemInstruction },
            { role: 'user', content: safeMessage }
          ],
          temperature: 0.5,
          max_tokens: 512
        })
      });

      const data = await response.json();

      if (response.ok && data?.choices?.[0]?.message?.content) {
        let reply = data.choices[0].message.content;
        reply = reply.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        // برگرداندن هر دو فرمت reply و text و answer برای سازگاری ۱۰۰٪ با هر تغییری در فرانت‌اند
        return res.json({ ok: true, success: true, reply, text: reply, answer: reply, modelUsed: modelName });
      } else {
        lastError = `(${modelName}): ${data?.error?.message || 'خطا'}`;
      }
    }

    return res.status(400).json({ ok: false, reply: `خطای سرویس هوش مصنوعی ${lastError}` });

  } catch (error) {
    console.error('AI Chat Server Error:', error);
    res.status(500).json({ ok: false, reply: 'خطا در ارتباط سرور با هوش مصنوعی.' });
  }
});

  try {
    const message = String((req.body && req.body.message) || '').trim().slice(0, 4000);
    if (!message) {
      return res.status(400).json({ ok: false, message: 'متن پرسش نمی‌تواند خالی باشد.' });
    }

    const history = Array.isArray(req.body && req.body.history) ? req.body.history.slice(-8) : [];
    const publicContext = sanitizePayload((req.body && req.body.publicContext) || {});

    const genaiMod = await import('@google/genai');
    const GoogleGenAI = genaiMod.GoogleGenAI;
    const ai = new GoogleGenAI({ apiKey });

    const systemInstruction =
      'شما دستیار رسمی و مودب سامانه جامع سراهای دانشجویی دانشگاه فرهنگیان اصفهان هستید. ' +
      'پاسخ‌ها را دقیق، کوتاه، فارسی و صرفاً بر اساس اطلاعات عمومی ارائه‌شده در کانتکست تنظیم کنید و هیچ اطلاعات محرمانه یا هویتی سایر کاربران را افشا نکنید.';

    const contents = [
      ...history.map((item) => ({
        role: item && item.role === 'model' ? 'model' : 'user',
        parts: [{ text: String((item && item.text) || '').slice(0, 2000) }],
      })),
      {
        role: 'user',
        parts: [
          {
            text: `کانتکست عمومی سامانه:\n${JSON.stringify(publicContext).slice(0, 24000)}\n\nپرسش کاربر:\n${message}`,
          },
        ],
      },
    ];

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents,
      config: { systemInstruction },
    });

    const reply = (response && response.text) || 'پاسخی دریافت نشد.';
    return res.json({ ok: true, reply, sources: [] });
  } catch (err) {
    console.error('POST /api/ai-chat error:', err && err.message);
    return res.status(500).json({
      ok: false,
      message: 'خطا در برقراری ارتباط با سرویس دستیار هوشمند.',
    });
  }
});

// ============================================================================
// 404 & Error Handlers
// ============================================================================
app.use((_req, res) => {
  res.status(404).json({ ok: false, message: 'مسیر درخواستی یافت نشد.' });
});

app.use((err, _req, res, _next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ ok: false, message: 'حجم داده‌های ارسالی بیش از حد مجاز است.' });
  }
  if (err && typeof err.message === 'string' && err.message.includes('CORS')) {
    return res.status(403).json({ ok: false, message: 'دسترسی از این دامنه مجاز نیست.' });
  }
  return res.status(500).json({ ok: false, message: 'خطای داخلی سرور' });
});

if (!process.env.VERCEL && require.main === module) {
  const port = Number(process.env.PORT || 4000);
  app.listen(port, () => {
    console.log(`khabgah-api backend listening on port ${port}`);
  });
}

module.exports = app;
