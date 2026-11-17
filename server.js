import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import compression from 'compression';
import helmet from 'helmet';
import { MongoClient } from 'mongodb';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// ============================================================================
// Security Allowlists & Configuration
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
// Middlewares: Helmet, Compression, Strict CORS, JSON Parser, Rate Limiter
// ============================================================================
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: false,
  })
);

app.use(compression({ threshold: 1024 }));

const rawAllowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (rawAllowedOrigins.length === 0) return callback(null, true);
      if (rawAllowedOrigins.includes('*') || rawAllowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error('Origin not allowed by CORS policy'));
    },
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'If-None-Match', 'X-Sync-Token'],
    exposedHeaders: ['ETag'],
    maxAge: 86400,
  })
);

app.use(express.json({ limit: '6mb' }));

// Sliding-window in-memory rate limiter (bounded Map to prevent unbounded memory growth)
const rateBuckets = new Map();
function createRateLimiter({ windowMs, maxRequests, keyPrefix }) {
  return (req, res, next) => {
    const ip =
      (typeof req.headers['x-forwarded-for'] === 'string'
        ? req.headers['x-forwarded-for'].split(',')[0].trim()
        : '') ||
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

const readLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 240, keyPrefix: 'r' });
const writeLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 120, keyPrefix: 'w' });
const aiLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 20, keyPrefix: 'ai' });

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
// Singleton Pooled MongoDB Atlas Connection + Index Initialization
// ============================================================================
const MONGO_URI = process.env.MONGODB_URI || '';
const DB_NAME = process.env.MONGODB_DB_NAME || 'khabgah_db';

async function getDb() {
  if (!MONGO_URI) {
    throw new Error('MONGODB_URI is not configured');
  }

  if (!globalThis._khabgahMongoPromise) {
    const client = new MongoClient(MONGO_URI, {
      maxPoolSize: 10,
      minPoolSize: 1,
      maxIdleTimeMS: 60_000,
      serverSelectionTimeoutMS: 5_000,
      socketTimeoutMS: 20_000,
      compressors: ['zlib'],
    });
    globalThis._khabgahMongoPromise = client.connect().catch((err) => {
      globalThis._khabgahMongoPromise = null;
      throw err;
    });
  }

  const connectedClient = await globalThis._khabgahMongoPromise;
  const db = connectedClient.db(DB_NAME);

  if (!globalThis._khabgahIndexesPromise) {
    globalThis._khabgahIndexesPromise = Promise.all([
      db.collection('sync_kv').createIndex({ key: 1 }, { unique: true, background: true }),
      db.collection('students').createIndex({ studentId: 1 }, { unique: true, background: true }),
      db.collection('photos').createIndex({ role: 1, userId: 1 }, { unique: true, background: true }),
      db.collection('sync_meta').createIndex({ id: 1 }, { unique: true, background: true }),
    ]).catch(() => {
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
  return result?.revision ?? Date.now();
}

async function getGlobalMeta(db) {
  const meta = await db
    .collection('sync_meta')
    .findOne({ id: 'global' }, { projection: { _id: 0, revision: 1, updatedAt: 1 } });
  return {
    revision: meta?.revision ?? 0,
    updatedAt: meta?.updatedAt ?? null,
  };
}

function makeWeakEtag(raw) {
  const digest = crypto.createHash('sha256').update(String(raw)).digest('base64url').slice(0, 24);
  return `"${digest}"`;
}

// ============================================================================
// Health & Version Endpoints
// ============================================================================
app.get('/api/health', readLimiter, async (_req, res) => {
  try {
    const db = await getDb();
    await db.command({ ping: 1 });
    res.json({ ok: true, status: 'healthy', timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ ok: false, status: 'unavailable' });
  }
});

app.get('/api/sync/version', readLimiter, async (_req, res) => {
  try {
    const db = await getDb();
    const meta = await getGlobalMeta(db);
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, revision: meta.revision, updatedAt: meta.updatedAt });
  } catch {
    res.status(500).json({ ok: false, message: 'خطا در بررسی نسخه سرور' });
  }
});

// ============================================================================
// Sync Endpoints (GET, POST single, POST batch) with ETag / 304 Not Modified
// ============================================================================
app.get('/api/sync', readLimiter, async (req, res) => {
  try {
    const db = await getDb();
    const meta = await getGlobalMeta(db);
    const docs = await db
      .collection('sync_kv')
      .find({}, { projection: { _id: 0, key: 1, value: 1, updatedAt: 1 } })
      .toArray();

    const etag = makeWeakEtag(`sync:${meta.revision}:${docs.length}`);
    res.set('ETag', etag);
    res.set('Cache-Control', 'private, no-cache');

    if (req.headers['if-none-match'] && req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }

    const kvMap = {};
    for (const doc of docs) {
      if (doc && typeof doc.key === 'string' && ALLOWED_SYNC_KEYS.has(doc.key)) {
        kvMap[doc.key] = doc.value;
      }
    }

    return res.json(kvMap);
  } catch {
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
  } catch {
    return res.status(500).json({ ok: false, message: 'خطا در ذخیره‌سازی داده در پایگاه داده' });
  }
});

app.post('/api/sync/batch', writeLimiter, requireSyncTokenIfConfigured, async (req, res) => {
  try {
    const entries = req.body?.entries;
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
  } catch {
    return res.status(500).json({ ok: false, message: 'خطا در ذخیره‌سازی دسته‌ای داده‌ها' });
  }
});

// ============================================================================
// Dedicated Students Endpoints with ETag & Safe Record Handling
// ============================================================================
app.get('/api/students', readLimiter, async (req, res) => {
  try {
    const db = await getDb();
    const meta = await getGlobalMeta(db);
    const students = await db
      .collection('students')
      .find({}, { projection: { _id: 0 } })
      .toArray();

    const etag = makeWeakEtag(`students:${meta.revision}:${students.length}`);
    res.set('ETag', etag);
    res.set('Cache-Control', 'private, no-cache');

    if (req.headers['if-none-match'] && req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }

    return res.json(students);
  } catch {
    return res.status(500).json({ ok: false, message: 'خطا در دریافت فهرست دانشجویان' });
  }
});

app.post('/api/students', writeLimiter, requireSyncTokenIfConfigured, async (req, res) => {
  try {
    const body = sanitizePayload(req.body || {});
    const listInput = Array.isArray(body?.students)
      ? body.students
      : body?.student && typeof body.student === 'object'
      ? [body.student]
      : body?.studentId
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
      const doc = { ...rawStudent, studentId, updatedAt: nowIso };
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
    if (body?.replaceAll === true && validIds.size > 0) {
      await db.collection('students').deleteMany({ studentId: { $nin: Array.from(validIds) } });
    }
    const revision = await bumpGlobalRevision(db);

    return res.json({
      ok: true,
      count: ops.length,
      student: firstValid,
      revision,
      message: 'اطلاعات دانشجو با موفقیت در پایگاه داده ثبت شد.',
    });
  } catch {
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
  } catch {
    return res.status(500).json({ ok: false, message: 'خطا در حذف پرونده دانشجو' });
  }
});

// ============================================================================
// Avatar / Profile Photo Endpoints (Binary Storage + ETag + Immutable Caching)
// ============================================================================
app.post('/api/photos/batch', writeLimiter, requireSyncTokenIfConfigured, async (req, res) => {
  try {
    const items = req.body?.items;
    if (!Array.isArray(items) || items.length === 0 || items.length > 30) {
      return res.status(400).json({ ok: false, message: 'فهرست تصاویر ارسالی نامعتبر است.' });
    }

    const publicBase = (process.env.PUBLIC_API_BASE_URL || '').trim().replace(/\/+$/, '');
    const inferredBase = publicBase || `${req.protocol}://${req.get('host')}/api`;
    const nowTs = Date.now();
    const ops = [];
    const urls = {};

    for (const item of items) {
      const role = String(item?.role || '').trim();
      const userId = String(item?.userId || '').trim();
      const dataUrl = String(item?.dataUrl || '').trim();

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
  } catch {
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
  } catch {
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
  } catch {
    return res.status(500).end();
  }
});

// ============================================================================
// Optional Server-Side Gemini Assistant Proxy (API Key Never Exposed to Client)
// ============================================================================
app.post('/api/ai-chat', aiLimiter, async (req, res) => {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) {
    return res.status(503).json({
      ok: false,
      message: 'کلید سرویس دستیار هوشمند در سرور تنظیم نشده است.',
    });
  }

  try {
    const message = String(req.body?.message || '').trim().slice(0, 4000);
    if (!message) {
      return res.status(400).json({ ok: false, message: 'متن پرسش نمی‌تواند خالی باشد.' });
    }

    const history = Array.isArray(req.body?.history) ? req.body.history.slice(-8) : [];
    const publicContext = sanitizePayload(req.body?.publicContext || {});

    const { GoogleGenAI } = await import('@google/genai');
    const ai = new GoogleGenAI({ apiKey });

    const systemInstruction =
      'شما دستیار رسمی و مودب سامانه جامع سراهای دانشجویی دانشگاه فرهنگیان اصفهان هستید. ' +
      'پاسخ‌ها را دقیق، کوتاه، فارسی و صرفاً بر اساس اطلاعات عمومی ارائه‌شده در کانتکست تنظیم کنید و هیچ اطلاعات محرمانه یا هویتی سایر کاربران را افشا نکنید.';

    const contents = [
      ...history.map((item) => ({
        role: item?.role === 'model' ? 'model' : 'user',
        parts: [{ text: String(item?.text || '').slice(0, 2000) }],
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

    const reply = response?.text || 'پاسخی دریافت نشد.';
    return res.json({ ok: true, reply, sources: [] });
  } catch {
    return res.status(500).json({
      ok: false,
      message: 'خطا در برقراری ارتباط با سرویس دستیار هوشمند.',
    });
  }
});

// ============================================================================
// 404 & Sanitized Error Handler (Never Leak Stack Traces or Secrets)
// ============================================================================
app.use((_req, res) => {
  res.status(404).json({ ok: false, message: 'مسیر درخواستی یافت نشد.' });
});

app.use((err, _req, res, _next) => {
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ ok: false, message: 'حجم داده‌های ارسالی بیش از حد مجاز است.' });
  }
  if (err?.message?.includes('CORS')) {
    return res.status(403).json({ ok: false, message: 'دسترسی از این دامنه مجاز نیست.' });
  }
  return res.status(500).json({ ok: false, message: 'خطای داخلی سرور' });
});

if (!process.env.VERCEL) {
  const port = Number(process.env.PORT || 4000);
  app.listen(port, () => {
    console.log(`khabgah-api backend listening on port ${port}`);
  });
}

export default app;
