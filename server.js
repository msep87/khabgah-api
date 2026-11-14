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
// مسیر دستیار هوشمند خوابگاهی و آموزشی با انتخاب خودکار و چرخشی مدل‌های Groq
// ============================================================================
app.get('/api/ai-chat', (req, res) => {
  res.json({
    ok: true,
    provider: 'Groq (Auto Model Fallback)',
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

    // تابع کمکی برای حذف رشته‌های Base64 و محدود کردن ایمن طول هر بخش
    const cleanAndTruncate = (obj, maxLength = 2500) => {
      if (!obj) return '';
      try {
        const str = JSON.stringify(obj, (key, value) => {
          if (
            typeof value === 'string' &&
            (value.startsWith('data:image') || value.length > 500)
          ) {
            return '[حذف شده برای کاهش حجم]';
          }
          return value;
        });
        return str.length > maxLength
          ? str.substring(0, maxLength) + '... [خلاصه شده]'
          : str;
      } catch (e) {
        return '';
      }
    };

    const ctx = publicContext && typeof publicContext === 'object' ? publicContext : {};
    const effectiveStudentInfo = studentInfo || ctx.currentUserContext || 'کاربر مهمان';

    // خلاصه‌سازی مجزا برای هر بخش تا اطلاعات حیاتی (مثل اطلاعیه‌ها و کاربر فعلی) قطع نشوند
    const safeAcademicAndStats = cleanAndTruncate(
      {
        academicInfo: ctx.academicInfo,
        overallStats: ctx.overallStats,
        dormsSummary: ctx.dormsSummary,
      },
      1400
    );
    const safeRooms = cleanAndTruncate(ctx.roomsSummary, 2400);
    const safeAnnouncements = cleanAndTruncate(ctx.publicAnnouncements, 1200);
    const safeShifts = cleanAndTruncate(
      {
        supervisorShifts: ctx.supervisorShiftsSummary,
        counselorShifts: ctx.counselorShiftsSummary,
      },
      1200
    );
    const safeStudent = cleanAndTruncate(effectiveStudentInfo, 900);
    const safeMessage = String(message || 'سلام').substring(0, 1000);

    const systemInstruction = `
تو دستیار هوشمند رسمی «سامانه اسکان و امور سراهای دانشجویی دانشگاه فرهنگیان اصفهان» هستی.
به سوالات دانشجویان درباره اطلاعات سراها، ظرفیت اتاق‌ها، میانگین نمرات اتاق‌ها، اطلاعیه‌ها، برنامه حضور سرپرستان و مشاوران و مسائل خوابگاهی و آموزشی به زبان فارسی روان و محترمانه پاسخ بده.
خط قرمز امنیتی: هرگز اطلاعات شخصی و حساس (کد ملی، شماره تماس، رمز عبور، آدرس و نام یا محل اسکان سایر افراد) را فاش نکن.

اطلاعات کلی و سراها:
${safeAcademicAndStats}

وضعیت اتاق‌ها (بدون اسامی ساکنین):
${safeRooms}

اطلاعیه‌های عمومی:
${safeAnnouncements}

برنامه شیفت سرپرستان و مشاوران:
${safeShifts}

اطلاعات کاربر فعلی:
${safeStudent || 'کاربر مهمان'}
`.trim();

    // دریافت لیست مدل‌های فعال اکانت شما در Groq
    let candidateModels = [
      'meta-llama/llama-4-scout-17b-16e-instruct',
      'meta-llama/llama-4-maverick-17b-128e-instruct',
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant',
      'qwen/qwen3-32b',
      'qwen-qwq-32b',
      'gemma2-9b-it',
    ];

    try {
      const modelsRes = await fetch('https://api.groq.com/openai/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (modelsRes.ok) {
        const modelsData = await modelsRes.json();
        const availableIds = (modelsData.data || [])
          .map((m) => m.id)
          // حذف مدل‌های صوتی، امنیتی، تصویری و مدل کم‌حافظه allam
          .filter(
            (id) =>
              !id.includes('whisper') &&
              !id.includes('tts') &&
              !id.includes('guard') &&
              !id.includes('allam') &&
              !id.includes('vision') &&
              !id.includes('audio') &&
              !id.includes('orpheus')
          );

        const prioritized = candidateModels.filter((m) =>
          availableIds.includes(m)
        );
        const others = availableIds.filter((m) => !prioritized.includes(m));
        if (prioritized.length > 0 || others.length > 0) {
          candidateModels = [...prioritized, ...others];
        }
      }
    } catch (e) {
      console.error('Error fetching models:', e);
    }

    // افزودن حداکثر ۴ پیام اخیر تاریخچه مکالمه برای حفظ جریان گفتگو بدون افزایش بیش از حد توکن
    const chatMessages = [{ role: 'system', content: systemInstruction }];
    if (Array.isArray(history)) {
      for (const turn of history.slice(-4)) {
        if (turn && typeof turn.text === 'string' && turn.text.trim()) {
          chatMessages.push({
            role:
              turn.role === 'model' || turn.role === 'assistant'
                ? 'assistant'
                : 'user',
            content: turn.text.trim().substring(0, 450),
          });
        }
      }
    }
    chatMessages.push({ role: 'user', content: safeMessage });

    // تست چرخشی مدل‌ها تا اولین مدلی که بدون خطا جواب می‌دهد
    let lastError = 'مدلی یافت نشد';
    for (const modelName of candidateModels.slice(0, 5)) {
      const response = await fetch(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: modelName,
            messages: chatMessages,
            temperature: 0.5,
            max_tokens: 768,
          }),
        }
      );

      const data = await response.json().catch(() => ({}));

      if (response.ok && data?.choices?.[0]?.message?.content) {
        let reply = data.choices[0].message.content;
        reply = reply.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        return res.json({ success: true, reply, modelUsed: modelName });
      } else {
        lastError = `(${modelName}): ${data?.error?.message || 'خطا'}`;
        console.warn('Model failed, trying next:', lastError);
      }
    }

    const errMsg = `خطای سرویس هوش مصنوعی ${lastError}`;
    return res.status(400).json({ error: errMsg, reply: errMsg });
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
