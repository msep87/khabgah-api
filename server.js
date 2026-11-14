const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();

// تنظیمات CORS و محدودیت حجم بدنه
app.use(
  cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// ============================================================================
// اتصال کش‌شده به MongoDB Atlas (فقط از متغیر محیطی Vercel خوانده می‌شود)
// ============================================================================
const MONGODB_URI =
  process.env.MONGODB_URI || process.env.MONGO_URI || process.env.DATABASE_URL;

let cached = global.__mongooseCache;
if (!cached) {
  cached = global.__mongooseCache = { conn: null, promise: null };
}

async function connectToDatabase() {
  if (cached.conn) {
    return cached.conn;
  }
  if (!MONGODB_URI) {
    throw new Error('متغیر محیطی MONGODB_URI در تنظیمات Vercel تعریف نشده است.');
  }
  if (!cached.promise) {
    cached.promise = mongoose
      .connect(MONGODB_URI, {
        bufferCommands: false,
        serverSelectionTimeoutMS: 8000,
      })
      .then((m) => m);
  }
  cached.conn = await cached.promise;
  return cached.conn;
}

// ============================================================================
// مدل‌های دیتابیس MongoDB
// ============================================================================
const syncDataSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    value: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true, strict: false }
);

const studentSchema = new mongoose.Schema(
  {
    studentId: { type: String, required: true, unique: true, index: true },
    nationalId: { type: String, default: '' },
    fullName: { type: String, default: '' },
  },
  { timestamps: true, strict: false }
);

const SyncData =
  mongoose.models.SyncData || mongoose.model('SyncData', syncDataSchema);
const StudentModel =
  mongoose.models.Student || mongoose.model('Student', studentSchema);

// ============================================================================
// مسیر بررسی سلامت سرور
// ============================================================================
app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'khabgah-api',
    message: 'سرور ابری سامانه جامع سراهای دانشجویی فعال است.',
    endpoints: ['/api/sync', '/api/students', '/api/ai-chat'],
  });
});

// ============================================================================
// مسیرهای همگام‌سازی سراسری سامانه (/api/sync)
// ============================================================================
app.get('/api/sync', async (req, res) => {
  try {
    await connectToDatabase();
    const docs = await SyncData.find({}).lean();
    const result = {};
    for (const doc of docs) {
      if (doc && doc.key) {
        result[doc.key] = doc.value;
      }
    }
    return res.json(result);
  } catch (error) {
    console.error('GET /api/sync error:', error);
    return res.status(500).json({
      message: 'خطا در دریافت داده‌های همگام‌سازی از MongoDB Atlas',
      error: error.message,
    });
  }
});

app.post('/api/sync', async (req, res) => {
  try {
    await connectToDatabase();
    const { key, value } = req.body || {};
    if (!key || typeof key !== 'string') {
      return res.status(400).json({ message: 'کلید همگام‌سازی (key) معتبر نیست.' });
    }

    await SyncData.findOneAndUpdate(
      { key },
      { $set: { key, value } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return res.json({ success: true, key });
  } catch (error) {
    console.error('POST /api/sync error:', error);
    return res.status(500).json({
      message: 'خطا در ذخیره‌سازی داده در MongoDB Atlas',
      error: error.message,
    });
  }
});

// ============================================================================
// مسیرهای مدیریت دانشجویان (/api/students)
// ============================================================================
app.get('/api/students', async (req, res) => {
  try {
    await connectToDatabase();
    const students = await StudentModel.find({}).sort({ createdAt: -1 }).lean();
    return res.json(students);
  } catch (error) {
    console.error('GET /api/students error:', error);
    return res.status(500).json({
      message: 'خطا در دریافت لیست دانشجویان از دیتابیس ابری',
      error: error.message,
    });
  }
});

app.post('/api/students', async (req, res) => {
  try {
    await connectToDatabase();
    const payload = req.body || {};
    if (!payload.studentId) {
      return res.status(400).json({ message: 'شماره دانشجویی الزامی است.' });
    }

    const existing = await StudentModel.findOne({
      studentId: String(payload.studentId),
    }).lean();
    if (existing) {
      return res.status(409).json({
        message: 'دانشجویی با این شماره دانشجویی قبلاً در دیتابیس ابری ثبت شده است.',
      });
    }

    const created = await StudentModel.create({
      ...payload,
      studentId: String(payload.studentId),
    });

    return res.status(201).json({
      message: 'دانشجو با موفقیت در دیتابیس ابری ثبت شد.',
      student: created.toObject(),
    });
  } catch (error) {
    console.error('POST /api/students error:', error);
    return res.status(500).json({
      message: 'خطا در ثبت دانشجو در دیتابیس ابری',
      error: error.message,
    });
  }
});

app.put('/api/students/:studentId', async (req, res) => {
  try {
    await connectToDatabase();
    const { studentId } = req.params;
    const updated = await StudentModel.findOneAndUpdate(
      { studentId: String(studentId) },
      { $set: req.body || {} },
      { new: true }
    ).lean();

    if (!updated) {
      return res.status(404).json({ message: 'دانشجوی موردنظر یافت نشد.' });
    }
    return res.json({
      message: 'اطلاعات دانشجو به‌روزرسانی شد.',
      student: updated,
    });
  } catch (error) {
    console.error('PUT /api/students/:studentId error:', error);
    return res.status(500).json({
      message: 'خطا در ویرایش اطلاعات دانشجو',
      error: error.message,
    });
  }
});

app.delete('/api/students/:studentId', async (req, res) => {
  try {
    await connectToDatabase();
    const { studentId } = req.params;
    await StudentModel.deleteOne({ studentId: String(studentId) });
    return res.json({
      success: true,
      message: 'دانشجو از دیتابیس ابری حذف شد.',
    });
  } catch (error) {
    console.error('DELETE /api/students/:studentId error:', error);
    return res.status(500).json({
      message: 'خطا در حذف دانشجو از دیتابیس ابری',
      error: error.message,
    });
  }
});

// ============================================================================
// مسیر دستیار هوشمند خوابگاهی و آموزشی با انتخاب خودکار مدل فعال Groq
// ============================================================================
app.get('/api/ai-chat', (req, res) => {
  res.json({
    ok: true,
    provider: 'Groq (Auto Model Discovery)',
    message: 'برای گفتگو با دستیار هوشمند از متد POST استفاده کنید.',
  });
});

app.post('/api/ai-chat', async (req, res) => {
  try {
    const { message, history = [], publicContext, studentInfo } = req.body || {};
    const apiKey = (
      process.env.GROQ_API_KEY ||
      process.env.GEMINI_API_KEY ||
      ''
    ).trim();

    if (!apiKey) {
      return res.status(500).json({
        error: 'کلید API در تنظیمات سرور (Vercel) یافت نشد.',
        reply: 'کلید API در تنظیمات سرور (Vercel) یافت نشد.',
      });
    }

    const effectiveUserContext =
      studentInfo ||
      (publicContext && publicContext.currentUserContext) ||
      'کاربر مهمان';

    const systemInstruction = `
تو دستیار هوشمند رسمی «سامانه اسکان و امور سراهای دانشجویی دانشگاه فرهنگیان اصفهان» هستی.
به سوالات دانشجویان و کاربران درباره اطلاعات عمومی سراها، اطلاعیه‌ها، مسائل خوابگاهی، آموزشی، علمی و عمومی به زبان فارسی روان، دقیق و محترمانه پاسخ بده.
خط قرمز امنیتی: تحت هیچ شرایطی اطلاعات شخصی و حساس دانشجویان و کاربران (کد ملی، شماره تماس، رمز عبور، آدرس، پرونده انضباطی و محل اسکان سایر افراد) را فاش نکن.

اطلاعات عمومی سامانه:
${publicContext ? JSON.stringify(publicContext) : ''}

اطلاعات کاربر فعلی:
${typeof effectiveUserContext === 'string' ? effectiveUserContext : JSON.stringify(effectiveUserContext)}
`;

    // ۱. دریافت خودکار لیست مدل‌های فعال از اکانت Groq شما تا هرگز خطای نام مدل ندهد
    let selectedModel = 'llama-3.1-8b-instant';
    try {
      const modelsRes = await fetch('https://api.groq.com/openai/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (modelsRes.ok) {
        const modelsData = await modelsRes.json();
        const availableIds = (modelsData.data || []).map((m) => m.id);

        // اولویت انتخاب بهترین مدل‌های متنی موجود در اکانت
        const preferredModels = [
          'meta-llama/llama-4-scout-17b-16e-instruct',
          'meta-llama/llama-4-maverick-17b-128e-instruct',
          'qwen-qwq-32b',
          'deepseek-r1-distill-llama-70b',
          'llama-3.3-70b-versatile',
          'llama-3.3-70b-specdec',
          'llama-3.1-8b-instant',
          'gemma2-9b-it',
        ];

        const found = preferredModels.find((m) => availableIds.includes(m));
        if (found) {
          selectedModel = found;
        } else {
          // انتخاب اولین مدل چت موجود که مدل صوتی (whisper/tts) یا امنیتی (guard) نباشد
          const fallback = availableIds.find(
            (id) =>
              !id.includes('whisper') &&
              !id.includes('tts') &&
              !id.includes('guard') &&
              !id.includes('audio')
          );
          if (fallback) selectedModel = fallback;
        }
      }
    } catch (e) {
      console.error('Error fetching Groq models list:', e);
    }

    // آماده‌سازی پیام‌ها شامل تاریخچه مکالمه قبلی + پیام فعلی کاربر
    const chatMessages = [{ role: 'system', content: systemInstruction }];

    if (Array.isArray(history)) {
      for (const turn of history.slice(-8)) {
        if (turn && typeof turn.text === 'string' && turn.text.trim()) {
          chatMessages.push({
            role:
              turn.role === 'model' || turn.role === 'assistant'
                ? 'assistant'
                : 'user',
            content: turn.text.trim(),
          });
        }
      }
    }

    chatMessages.push({
      role: 'user',
      content:
        typeof message === 'string' && message.trim() ? message.trim() : 'سلام',
    });

    // ۲. ارسال پیام کاربر به مدل فعال انتخاب‌شده
    const response = await fetch(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: selectedModel,
          messages: chatMessages,
          temperature: 0.5,
          max_tokens: 1024,
        }),
      }
    );

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error('Groq API Error:', data);
      const errMsg = `خطای سرویس هوش مصنوعی (${selectedModel}): ${
        data?.error?.message || 'خطای نامشخص'
      }`;
      return res.status(response.status).json({
        error: errMsg,
        reply: errMsg,
      });
    }

    // پاک کردن تگ‌های فکر کردن احتمالی در مدل‌های استدلالی
    let reply = data?.choices?.[0]?.message?.content || 'پاسخی دریافت نشد.';
    reply = reply.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

    return res.json({ success: true, reply, modelUsed: selectedModel });
  } catch (error) {
    console.error('AI Chat Server Error:', error);
    return res.status(500).json({
      error: 'خطا در ارتباط سرور با هوش مصنوعی.',
      reply: 'خطا در ارتباط سرور با هوش مصنوعی.',
    });
  }
});

// اجرای محلی
if (require.main === module) {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => {
    console.log(`khabgah-api running on port ${PORT}`);
  });
}

module.exports = app;
