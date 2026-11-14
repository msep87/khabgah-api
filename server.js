const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();

// تنظیمات CORS و محدودیت حجم بدنه برای پشتیبانی از تصاویر/فونت‌ها و کانتکست چت
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
// اتصال کش‌شده به MongoDB Atlas (بهینه‌شده برای محیط Serverless Vercel)
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
    throw new Error('متغیر محیطی MONGODB_URI در تنظیمات سرور تعریف نشده است.');
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
// مدل‌های دیتابیس MongoDB (سازگار با کلید-مقدارهای همگام‌سازی و مجموعه دانشجویان)
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
// مسیر جدید دستیار هوشمند خوابگاهی و آموزشی مجهز به Gemini و جستجوی زنده وب
// ============================================================================
app.post('/api/ai-chat', async (req, res) => {
  try {
    const { message, history = [], publicContext = {} } = req.body || {};

    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'متن پیام کاربر نمی‌تواند خالی باشد.' });
    }

    const apiKey =
      process.env.GEMINI_API_KEY ||
      'AQ.Ab8RN6Lu79h4vT24VwbbhLH5RSo_eIWSnZCCVIcQWPJ6_kolwQ';

    const systemInstructionText = [
      'تو دستیار هوشمند جامع خوابگاهی و آموزشی «سامانه جامع سراهای دانشجویی دانشگاه فرهنگیان استان اصفهان» هستی.',
      'به زبان فارسی روان، دقیق، صمیمی و محترمانه پاسخ بده.',
      '',
      'حوزه پاسخگویی:',
      '۱. هیچ محدودیت موضوعی نداری: به هر سوالی درباره وضعیت سراها، ظرفیت اتاق‌ها و تخت‌های خالی/پر، امکانات اتاق‌ها، رشته‌ها و ورودی‌های مجاز، میانگین امتیاز سال قبل یا میانگین نمرات ارزیابی اتاق‌ها، اطلاعیه‌ها، زمان‌بندی انتخاب اتاق و برنامه حضور سرپرستان و مشاوران بر اساس داده‌های لحظه‌ای سامانه (publicContext) به دقت پاسخ بده.',
      '۲. برای سوالات آموزشی، علمی، پژوهشی، آیین‌نامه‌های دانشگاه فرهنگیان، امور دانشجویی، تغذیه، سلامت روان و یا هر سوال عمومی و روز دیگری که فراتر از داده‌های درون سامانه است، از ابزار جستجوی اینترنتی (Google Search) استفاده کن و پاسخ به‌روز و مستند ارائه بده.',
      '',
      'قوانین اکید حفظ حریم خصوصی و امنیت:',
      '- هرگز اطلاعات شخصی، هویتی یا محرمانه دانشجویان و کارکنان را فاش نکن؛ از جمله کد ملی، شماره موبایل، تلفن ثابت، تلفن والدین/اضطراری، نشانی منزل، رمز عبور، پیام‌های خصوصی مشاوره و اخطارهای انضباطی.',
      '- هرگز اسامی ساکنین یک اتاق یا تخت خاص را برای دیگران افشا نکن. اگر کاربری پرسید «چه کسانی در فلان اتاق ساکن هستند؟»، محترمانه توضیح بده که به دلیل حفظ حریم خصوصی، نمایش اسامی ساکنین اتاق‌ها مجاز نیست و فقط تعداد نفرات ساکن، ظرفیت خالی، امکانات و میانگین امتیاز اتاق قابل ارائه است.',
      '- تنها در صورتی که در بخش currentUserContext اطلاعات خودِ دانشجوی لاگین‌شده ارسال شده باشد، می‌توانی درباره وضعیت اسکان، اتاق، تخت و نمرات ارزیابیِ خودِ او پاسخ دهی.',
      '- اگر درباره موضوعی در داده‌های سامانه اطلاعاتی وجود ندارد، صادقانه اطلاع بده و از حدس زدن آمار جعلی خودداری کن.',
    ].join('\n');

    // تبدیل تاریخچه گفتگو به ساختار استاندارد Gemini REST API
    const contents = [];
    if (Array.isArray(history)) {
      for (const turn of history.slice(-10)) {
        if (
          turn &&
          typeof turn.text === 'string' &&
          turn.text.trim() &&
          (turn.role === 'user' || turn.role === 'model')
        ) {
          contents.push({
            role: turn.role,
            parts: [{ text: turn.text.trim() }],
          });
        }
      }
    }

    const contextString = JSON.stringify(publicContext || {}, null, 0);
    const enrichedUserPrompt =
      `اطلاعات عمومی و به‌روز سامانه (بدون اطلاعات حساس):\n${contextString}\n\n` +
      `پرسش کاربر:\n${message.trim()}`;

    contents.push({
      role: 'user',
      parts: [{ text: enrichedUserPrompt }],
    });

    const geminiRequestBody = {
      system_instruction: {
        parts: [{ text: systemInstructionText }],
      },
      contents,
      tools: [{ google_search: {} }],
      generationConfig: {
        temperature: 0.5,
        maxOutputTokens: 2048,
      },
    };

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${encodeURIComponent(
      apiKey
    )}`;

    const aiResponse = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiRequestBody),
    });

    const aiData = await aiResponse.json().catch(() => ({}));

    if (!aiResponse.ok) {
      console.error('Gemini API Error:', aiResponse.status, aiData);
      return res.status(aiResponse.status || 502).json({
        error:
          aiData?.error?.message ||
          'خطا در دریافت پاسخ از سرویس هوش مصنوعی Gemini.',
      });
    }

    const candidate = aiData?.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    const reply = parts
      .map((p) => (typeof p?.text === 'string' ? p.text : ''))
      .join('\n')
      .trim();

    // استخراج منابع جستجوی زنده گوگل (groundingMetadata.groundingChunks)
    const rawChunks = candidate?.groundingMetadata?.groundingChunks || [];
    const seenUris = new Set();
    const sources = [];

    for (const chunk of rawChunks) {
      const uri = chunk?.web?.uri;
      const title = chunk?.web?.title;
      if (uri && typeof uri === 'string' && !seenUris.has(uri)) {
        seenUris.add(uri);
        sources.push({
          title: (typeof title === 'string' && title.trim()) || uri,
          uri,
        });
      }
    }

    return res.json({
      reply:
        reply ||
        'متأسفانه در حال حاضر پاسخی تولید نشد. لطفاً سوال خود را با جزئیات بیشتر بپرسید.',
      sources,
    });
  } catch (error) {
    console.error('POST /api/ai-chat error:', error);
    return res.status(500).json({
      error: 'خطای داخلی سرور هنگام پردازش گفتگو با دستیار هوشمند.',
      details: error.message,
    });
  }
});

// اجرای محلی برای تست در صورت اجرا با node server.js
if (require.main === module) {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => {
    console.log(`khabgah-api running on port ${PORT}`);
  });
}

// خروجی الزامی برای Vercel Serverless
module.exports = app;
