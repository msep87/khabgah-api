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
// کمک‌تابع خواندن خلاصه عمومی ایمن از دیتابیس (بدون اطلاعات حساس یا هویتی)
// ============================================================================
async function getSafeDbPublicSummary() {
  try {
    await connectToDatabase();
    const docs = await SyncData.find({
      key: {
        $in: [
          'farhangian_dorm_dormitories_prod',
          'farhangian_dorm_announcements_prod',
          'farhangian_dorm_settings_prod',
        ],
      },
    }).lean();

    const dbSummary = {};
    for (const doc of docs) {
      if (doc.key === 'farhangian_dorm_dormitories_prod' && Array.isArray(doc.value)) {
        dbSummary.dormitories = doc.value.map((d) => ({
          name: d?.name || '',
          campus: d?.campus || '',
          gender: d?.gender === 'brothers' ? 'برادران' : 'خواهران',
          totalFloors: d?.totalFloors || 0,
        }));
      } else if (doc.key === 'farhangian_dorm_announcements_prod' && Array.isArray(doc.value)) {
        dbSummary.announcements = doc.value
          .filter((a) => a?.showOnHomePage !== false)
          .slice(0, 10)
          .map((a) => ({
            title: a?.title || '',
            content: a?.content || '',
            date: a?.date || '',
            priority: a?.priority || 'normal',
          }));
      } else if (doc.key === 'farhangian_dorm_settings_prod' && doc.value) {
        // دقت: رمز عبور مدیر (adminPassword) به هیچ وجه استخراج نمی‌شود
        dbSummary.settings = {
          universityName: doc.value.universityName || '',
          currentAcademicYear: doc.value.currentAcademicYear || '',
          currentSemester: doc.value.currentSemester || '',
          selectionActive: Boolean(doc.value.selectionActive),
          selectionStartDate: doc.value.selectionStartDate || '',
          selectionEndDate: doc.value.selectionEndDate || '',
        };
      }
    }
    return dbSummary;
  } catch (err) {
    console.warn('getSafeDbPublicSummary warning:', err.message);
    return null;
  }
}

// ============================================================================
// مسیر دستیار هوشمند خوابگاهی و آموزشی با Groq API (llama-3.3-70b-versatile)
// ============================================================================
app.get('/api/ai-chat', (req, res) => {
  res.json({
    ok: true,
    provider: 'Groq',
    model: 'llama-3.3-70b-versatile',
    message: 'برای گفتگو با دستیار هوشمند از متد POST استفاده کنید.',
  });
});

app.post('/api/ai-chat', async (req, res) => {
  try {
    const { message, history = [], publicContext = {} } = req.body || {};

    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'متن پیام کاربر نمی‌تواند خالی باشد.' });
    }

    const apiKey = (
      process.env.GROQ_API_KEY ||
      process.env.GEMINI_API_KEY ||
      ''
    ).trim();

    if (!apiKey) {
      return res.status(500).json({
        error:
          'کلید API هوش مصنوعی (GROQ_API_KEY یا GEMINI_API_KEY) در تنظیمات Environment Variables پروژه Vercel تعریف نشده است.',
      });
    }

    const hasClientContext =
      publicContext &&
      typeof publicContext === 'object' &&
      Object.keys(publicContext).length > 0;
    const dbFallbackSummary = hasClientContext
      ? null
      : await getSafeDbPublicSummary();

    const contextData = hasClientContext ? publicContext : dbFallbackSummary || {};

    const systemPrompt = [
      'تو دستیار هوشمند خوابگاهی و آموزشی «سامانه جامع سراهای دانشجویی دانشگاه فرهنگیان استان اصفهان» هستی.',
      'وظیفه تو پاسخگویی دقیق، محترمانه و روان به زبان فارسی به سوالات دانشجویان، سرپرستان و مراجعان درباره امور سراها، اسکان، اتاق‌ها، ظرفیت‌ها، میانگین نمرات ارزیابی اتاق‌ها، اطلاعیه‌ها، برنامه حضور سرپرستان و مشاوران و همچنین سوالات عمومی آموزشی، علمی و خوابگاهی است.',
      '',
      'قوانین اکید امنیتی و حفظ حریم خصوصی (بسیار مهم):',
      '۱. هرگز اطلاعات حساس و شخصی کاربران از جمله کد ملی، شماره موبایل، تلفن ثابت، شماره والدین/اضطراری، رمز عبور، نشانی منزل، پیام‌های خصوصی مشاوره و اخطارهای انضباطی را افشا نکن.',
      '۲. هرگز نام یا محل اسکان سایر دانشجویان (اینکه چه کسی در کدام اتاق یا تخت ساکن است) را فاش نکن. در پاسخ به پرسش درباره اتاق‌ها فقط آمار ظرفیت کل، تعداد پر و خالی، امکانات، رشته‌های مجاز و میانگین ناشناس نمرات را ارائه بده.',
      '۳. تنها در صورتی که در بخش currentUserContext اطلاعات خودِ دانشجوی لاگین‌شده موجود باشد، می‌توانی درباره وضعیت اسکان، اتاق، تخت و نمرات ارزیابیِ خودِ همان دانشجو پاسخ دهی.',
      '۴. اگر داده‌ای در اطلاعات سامانه وجود ندارد، صادقانه بیان کن و از حدس زدن آمار نادرست خودداری کن.',
      '',
      `اطلاعات عمومی و مجاز سامانه:\n${JSON.stringify(contextData)}`,
    ].join('\n');

    const messages = [{ role: 'system', content: systemPrompt }];

    // افزودن تاریخچه مکالمه قبلی با فرمت استاندارد OpenAI/Groq
    if (Array.isArray(history)) {
      for (const turn of history.slice(-8)) {
        if (turn && typeof turn.text === 'string' && turn.text.trim()) {
          messages.push({
            role: turn.role === 'model' || turn.role === 'assistant' ? 'assistant' : 'user',
            content: turn.text.trim(),
          });
        }
      }
    }

    messages.push({
      role: 'user',
      content: message.trim(),
    });

    const groqResponse = await fetch(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + apiKey,
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages,
          temperature: 0.5,
          max_tokens: 1024,
        }),
      }
    );

    const data = await groqResponse.json().catch(() => ({}));

    if (!groqResponse.ok) {
      console.error('Groq API Error:', groqResponse.status, data);
      return res.status(groqResponse.status || 502).json({
        error:
          data?.error?.message ||
          'خطا در دریافت پاسخ از سرویس هوش مصنوعی Groq.',
      });
    }

    const reply =
      data?.choices?.[0]?.message?.content?.trim() ||
      'متأسفانه پاسخی از دستیار هوشمند دریافت نشد. لطفاً دوباره تلاش کنید.';

    return res.json({
      success: true,
      reply,
    });
  } catch (error) {
    console.error('POST /api/ai-chat error:', error);
    return res.status(500).json({
      error: 'خطای داخلی سرور هنگام پردازش گفتگو با دستیار هوشمند.',
      details: error.message,
    });
  }
});

// اجرای محلی برای تست
if (require.main === module) {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => {
    console.log(`khabgah-api running on port ${PORT}`);
  });
}

module.exports = app;
