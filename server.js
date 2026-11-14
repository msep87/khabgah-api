require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();

// 1. تنظیمات CORS پیش از اتصال به دیتابیس تا OPTIONS هیچ‌وقت 500 نشود
const corsOptions = {
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

app.use(express.json({ limit: '15mb' }));

// 2. اتصال امن و کش‌شده به MongoDB برای محیط Serverless Vercel
let cached = global._mongooseCache;
if (!cached) {
  cached = global._mongooseCache = { conn: null, promise: null };
}

async function connectDB() {
  if (cached.conn) return cached.conn;

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('متغیر MONGODB_URI در تنظیمات محیطی Vercel تعریف نشده است.');
  }

  if (!cached.promise) {
    cached.promise = mongoose
      .connect(uri, { bufferCommands: false, serverSelectionTimeoutMS: 8000 })
      .then((m) => m);
  }
  cached.conn = await cached.promise;
  return cached.conn;
}

// 3. مدل‌های MongoDB
const SyncDataSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    value: { type: mongoose.Schema.Types.Mixed, required: true },
  },
  { timestamps: true }
);
const SyncData = mongoose.models.SyncData || mongoose.model('SyncData', SyncDataSchema);

const StudentSchema = new mongoose.Schema(
  {
    studentId: { type: String, required: true, unique: true, index: true },
  },
  { strict: false, timestamps: true }
);
const Student = mongoose.models.Student || mongoose.model('Student', StudentSchema);

// 4. تست سلامت سرور
app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'khabgah-api',
    hasMongoUri: Boolean(process.env.MONGODB_URI),
    dbReadyState: mongoose.connection.readyState,
  });
});

// 5. مسیر همگام‌سازی کلید-مقدار سراها، اتاق‌ها، تخت‌ها، دانشجویان و تنظیمات
app.get('/api/sync', async (req, res) => {
  try {
    await connectDB();
    const docs = await SyncData.find({}).lean();
    const result = {};
    for (const doc of docs) {
      result[doc.key] = doc.value;
    }
    res.json(result);
  } catch (err) {
    console.error('GET /api/sync error:', err);
    res.status(500).json({ message: err.message || 'خطا در دریافت اطلاعات از دیتابیس' });
  }
});

app.post('/api/sync', async (req, res) => {
  try {
    await connectDB();
    const { key, value } = req.body || {};
    if (!key) {
      return res.status(400).json({ message: 'کلید همگام‌سازی ارسال نشده است.' });
    }
    await SyncData.findOneAndUpdate(
      { key },
      { $set: { value } },
      { upsert: true, new: true }
    );
    res.json({ success: true, key });
  } catch (err) {
    console.error('POST /api/sync error:', err);
    res.status(500).json({ message: err.message || 'خطا در ذخیره‌سازی در دیتابیس' });
  }
});

// 6. مسیرهای مستقیم دانشجویان
app.get('/api/students', async (req, res) => {
  try {
    await connectDB();
    const students = await Student.find({}).sort({ createdAt: -1 }).lean();
    res.json(students);
  } catch (err) {
    console.error('GET /api/students error:', err);
    res.status(500).json({ message: err.message || 'خطا در دریافت لیست دانشجویان' });
  }
});

app.post('/api/students', async (req, res) => {
  try {
    await connectDB();
    const data = req.body || {};
    if (!data.studentId) {
      return res.status(400).json({ message: 'شماره دانشجویی الزامی است.' });
    }
    const exists = await Student.findOne({ studentId: String(data.studentId) }).lean();
    if (exists) {
      return res.status(409).json({ message: 'دانشجویی با این شماره دانشجویی قبلاً در دیتابیس ثبت شده است.' });
    }
    const created = await Student.create(data);
    res.status(201).json({
      success: true,
      message: 'دانشجو با موفقیت در دیتابیس ابری ثبت شد.',
      student: created.toObject(),
    });
  } catch (err) {
    console.error('POST /api/students error:', err);
    res.status(500).json({ message: err.message || 'خطا در ثبت دانشجو در دیتابیس ابری' });
  }
});

app.delete('/api/students/:studentId', async (req, res) => {
  try {
    await connectDB();
    await Student.deleteOne({ studentId: req.params.studentId });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/students error:', err);
    res.status(500).json({ message: err.message || 'خطا در حذف دانشجو' });
  }
});

// 7. اجرا فقط در محیط لوکال؛ در Vercel فقط app اکسپورت می‌شود
if (require.main === module) {
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

module.exports = app;
