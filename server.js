const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();

// تنظیم CORS برای دسترسی فرانت‌اند از همه دامنه‌ها
app.use(
  cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

// سقف امن زیر محدودیت ۴.۵ مگابایتی Vercel Serverless
app.use(express.json({ limit: '4mb' }));

// ==========================================
// اتصال پایدار و کش‌شده به MongoDB Atlas (مناسب Vercel Serverless)
// ==========================================
let cachedConn = null;
let connPromise = null;

async function connectDB() {
  if (cachedConn && mongoose.connection.readyState === 1) {
    return cachedConn;
  }

  const uri = process.env.MONGODB_URI || process.env.MONGO_URL;
  if (!uri) {
    throw new Error('MONGODB_URI environment variable is not defined.');
  }

  if (!connPromise) {
    connPromise = mongoose
      .connect(uri, {
        serverSelectionTimeoutMS: 10000,
        socketTimeoutMS: 20000,
      })
      .then((m) => {
        cachedConn = m;
        return m;
      })
      .catch((err) => {
        connPromise = null;
        throw err;
      });
  }

  return connPromise;
}

// ==========================================
// مدل‌های Mongoose
// ==========================================
const SyncItemSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    value: { type: mongoose.Schema.Types.Mixed, required: true },
  },
  { timestamps: true }
);

const StudentSchema = new mongoose.Schema(
  {
    studentId: { type: String, required: true, unique: true, index: true },
    nationalId: { type: String, required: true },
    fullName: { type: String, required: true },
  },
  { strict: false, timestamps: true }
);

const UserPhotoSchema = new mongoose.Schema(
  {
    role: {
      type: String,
      required: true,
      enum: ['student', 'supervisor', 'maintenance', 'warehouse', 'counselor'],
    },
    userId: { type: String, required: true },
    contentType: { type: String, default: 'image/jpeg' },
    dataUrl: { type: String, required: true },
    updatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

UserPhotoSchema.index({ role: 1, userId: 1 }, { unique: true });

const SyncItem = mongoose.models.SyncItem || mongoose.model('SyncItem', SyncItemSchema);
const Student = mongoose.models.Student || mongoose.model('Student', StudentSchema);
const UserPhoto = mongoose.models.UserPhoto || mongoose.model('UserPhoto', UserPhotoSchema);

// تابع کمکی ساخت آدرس پایه سرور
function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.get('host');
  return `${proto}://${host}`;
}

// ==========================================
// مسیر بررسی سلامت سرویس
// ==========================================
app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'khabgah-api',
    timestamp: new Date().toISOString(),
    endpoints: [
      '/api/sync',
      '/api/students',
      '/api/photos/batch',
      '/api/photo/:role/:userId',
      '/api/photos/manifest',
      '/api/ai-chat',
    ],
  });
});

// ==========================================
// 1. مسیرهای همگام‌سازی کلید-مقدار (/api/sync)
// ==========================================
app.get('/api/sync', async (req, res) => {
  try {
    await connectDB();
    const items = await SyncItem.find({}).lean();
    const result = {};
    for (const item of items) {
      result[item.key] = item.value;
    }
    res.json(result);
  } catch (err) {
    console.error('GET /api/sync error:', err);
    res.status(500).json({ ok: false, message: 'خطا در دریافت اطلاعات از دیتابیس ابری' });
  }
});

app.post('/api/sync', async (req, res) => {
  try {
    const { key, value } = req.body || {};
    if (!key || typeof key !== 'string' || value === undefined) {
      return res.status(400).json({ ok: false, message: 'کلید و مقدار معتبر الزامی است.' });
    }
    await connectDB();
    await SyncItem.findOneAndUpdate(
      { key },
      { $set: { value } },
      { upsert: true, new: true }
    );
    res.json({ ok: true, key });
  } catch (err) {
    console.error('POST /api/sync error:', err);
    res.status(500).json({ ok: false, message: 'خطا در ذخیره‌سازی همگام‌سازی ابری' });
  }
});

// ==========================================
// 2. مسیرهای دانشجویان (/api/students)
// ==========================================
app.get('/api/students', async (req, res) => {
  try {
    await connectDB();
    const students = await Student.find({}).lean();
    res.json(students);
  } catch (err) {
    console.error('GET /api/students error:', err);
    res.status(500).json({ ok: false, message: 'خطا در دریافت لیست دانشجویان' });
  }
});

app.post('/api/students', async (req, res) => {
  try {
    const payload = req.body || {};
    if (!payload.studentId || !payload.nationalId || !payload.fullName) {
      return res.status(400).json({
        ok: false,
        message: 'شماره دانشجویی، کد ملی و نام و نام خانوادگی الزامی است.',
      });
    }

    await connectDB();
    const existing = await Student.findOne({ studentId: String(payload.studentId).trim() }).lean();
    if (existing) {
      return res.status(409).json({
        ok: false,
        message: 'دانشجویی با این شماره دانشجویی قبلاً در دیتابیس ثبت شده است.',
      });
    }

    const created = await Student.create({
      ...payload,
      studentId: String(payload.studentId).trim(),
      nationalId: String(payload.nationalId).trim(),
      fullName: String(payload.fullName).trim(),
    });

    res.status(201).json({
      ok: true,
      student: created.toObject(),
      message: 'دانشجو با موفقیت در دیتابیس ابری ثبت شد.',
    });
  } catch (err) {
    console.error('POST /api/students error:', err);
    res.status(500).json({ ok: false, message: 'خطا در ثبت دانشجو در دیتابیس ابری' });
  }
});

// ==========================================
// 3. مسیرهای اختصاصی ذخیره و نمایش ابری تصاویر کاربران
// ==========================================
const ALLOWED_PHOTO_ROLES = new Set([
  'student',
  'supervisor',
  'maintenance',
  'warehouse',
  'counselor',
]);

app.post('/api/photos/batch', async (req, res) => {
  try {
    const { items } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok: false, message: 'آرایه تصاویر خالی است.' });
    }

    await connectDB();

    const now = new Date();
    const version = now.getTime();
    const baseUrl = getBaseUrl(req);
    const ops = [];
    const urls = {};

    for (const rawItem of items) {
      if (!rawItem || typeof rawItem !== 'object') continue;
      const role = String(rawItem.role || '').trim();
      const userId = String(rawItem.userId || '').trim();
      const dataUrl = String(rawItem.dataUrl || '').trim();

      if (!ALLOWED_PHOTO_ROLES.has(role) || !userId) continue;
      if (!dataUrl.startsWith('data:image/')) continue;

      const mimeMatch = dataUrl.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,/);
      const contentType = mimeMatch ? mimeMatch[1] : 'image/jpeg';

      ops.push({
        updateOne: {
          filter: { role, userId },
          update: {
            $set: {
              role,
              userId,
              contentType,
              dataUrl,
              updatedAt: now,
            },
          },
          upsert: true,
        },
      });

      urls[userId] = `${baseUrl}/api/photo/${encodeURIComponent(role)}/${encodeURIComponent(
        userId
      )}?v=${version}`;
    }

    if (ops.length === 0) {
      return res.status(400).json({ ok: false, message: 'هیچ تصویر معتبری برای ذخیره یافت نشد.' });
    }

    await UserPhoto.bulkWrite(ops, { ordered: false });

    res.json({
      ok: true,
      count: ops.length,
      urls,
    });
  } catch (err) {
    console.error('POST /api/photos/batch error:', err);
    res.status(500).json({ ok: false, message: 'خطا در ذخیره‌سازی ابری تصاویر در MongoDB' });
  }
});

app.get('/api/photo/:role/:userId', async (req, res) => {
  try {
    const role = String(req.params.role || '').trim();
    const userId = String(req.params.userId || '').trim();

    if (!ALLOWED_PHOTO_ROLES.has(role) || !userId) {
      return res.status(400).send('Invalid photo parameters');
    }

    await connectDB();
    const doc = await UserPhoto.findOne({ role, userId }).lean();
    if (!doc || !doc.dataUrl) {
      return res.status(404).send('Photo not found');
    }

    const match = String(doc.dataUrl).match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/);
    if (!match) {
      return res.status(500).send('Invalid stored image format');
    }

    const contentType = doc.contentType || match[1] || 'image/jpeg';
    const imgBuffer = Buffer.from(match[2], 'base64');

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(imgBuffer);
  } catch (err) {
    console.error('GET /api/photo error:', err);
    res.status(500).send('Error serving photo');
  }
});

app.delete('/api/photo/:role/:userId', async (req, res) => {
  try {
    const role = String(req.params.role || '').trim();
    const userId = String(req.params.userId || '').trim();
    if (!ALLOWED_PHOTO_ROLES.has(role) || !userId) {
      return res.status(400).json({ ok: false, message: 'پارامتر نامعتبر است.' });
    }
    await connectDB();
    await UserPhoto.deleteOne({ role, userId });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/photo error:', err);
    res.status(500).json({ ok: false, message: 'خطا در حذف تصویر' });
  }
});

app.get('/api/photos/manifest', async (req, res) => {
  try {
    await connectDB();
    const list = await UserPhoto.find({}, { role: 1, userId: 1, updatedAt: 1, _id: 0 }).lean();
    res.json({ ok: true, count: list.length, items: list });
  } catch (err) {
    console.error('GET /api/photos/manifest error:', err);
    res.status(500).json({ ok: false, message: 'خطا در دریافت فهرست تصاویر' });
  }
});

// ==========================================
// 4. مسیر دستیار هوشمند سراها (/api/ai-chat با Groq)
// ==========================================
function cleanAndTruncate(text, maxChars = 1100) {
  if (!text) return '';
  const normalized = String(text)
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(0, maxChars).trim() + '...';
}

app.post('/api/ai-chat', async (req, res) => {
  try {
    const apiKey = process.env.GROQ_API_KEY || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({
        error: 'کلید GROQ_API_KEY در تنظیمات Vercel تعریف نشده است.',
      });
    }

    const { message, history = [], publicContext = {} } = req.body || {};
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'متن پیام معتبر نیست.' });
    }

    // انتخاب مدل فعال Groq به‌صورت پویا
    let modelId = 'llama-3.3-70b-versatile';
    try {
      const modelsRes = await fetch('https://api.groq.com/openai/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (modelsRes.ok) {
        const modelsData = await modelsRes.json();
        const available = Array.isArray(modelsData?.data) ? modelsData.data.map((m) => m.id) : [];
        const preferred = [
          'llama-3.3-70b-versatile',
          'llama-3.1-8b-instant',
          'openai/gpt-oss-120b',
          'gemma2-9b-it',
        ];
        const found = preferred.find((p) => available.includes(p));
        if (found) modelId = found;
        else if (available.length > 0) modelId = available[0];
      }
    } catch {
      // استفاده از مدل پیش‌فرض
    }

    const systemPrompt =
      'شما دستیار هوشمند رسمی «سامانه جامع سراهای دانشجویی دانشگاه فرهنگیان استان اصفهان» هستید. ' +
      'پاسخ‌ها را با لحن محترمانه، دقیق، کوتاه و فقط به زبان فارسی بنویسید. ' +
      `اطلاعات عمومی فعلی سامانه: ${JSON.stringify(publicContext).slice(0, 2000)}`;

    const chatMessages = [{ role: 'system', content: systemPrompt }];
    if (Array.isArray(history)) {
      for (const h of history.slice(-8)) {
        if (!h || typeof h.text !== 'string') continue;
        chatMessages.push({
          role: h.role === 'model' || h.role === 'assistant' ? 'assistant' : 'user',
          content: h.text.slice(0, 1500),
        });
      }
    }
    chatMessages.push({ role: 'user', content: message.slice(0, 2000) });

    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: modelId,
        messages: chatMessages,
        temperature: 0.5,
        max_tokens: 700,
      }),
    });

    const groqData = await groqRes.json().catch(() => ({}));
    if (!groqRes.ok) {
      return res.status(502).json({
        error: groqData?.error?.message || 'خطا در ارتباط با سرویس هوش مصنوعی Groq',
      });
    }

    const rawReply = groqData?.choices?.[0]?.message?.content || '';
    res.json({
      reply: cleanAndTruncate(rawReply),
      sources: [],
    });
  } catch (err) {
    console.error('POST /api/ai-chat error:', err);
    res.status(500).json({ error: 'خطای داخلی سرور در پردازش پیام دستیار هوشمند' });
  }
});

// اجرای محلی (در Vercel از export استفاده می‌شود)
if (require.main === module) {
  const port = process.env.PORT || 3001;
  app.listen(port, () => {
    console.log(`khabgah-api running on port ${port}`);
  });
}

module.exports = app;
