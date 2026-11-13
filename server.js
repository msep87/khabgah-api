require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();

// -------------------------------------------------------------
// 1. تنظیمات CORS و افزایش محدودیت حجم برای تصاویر Base64
// -------------------------------------------------------------
const allowedOrigins = [
  'https://eskan-isfcfu.vercel.app',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];

app.use(
  cors({
    origin: function (origin, callback) {
      // اجازه درخواست‌های بدون origin (مثل تست سرور/Postman) یا دامنه‌های مجاز
      if (!origin || allowedOrigins.includes(origin) || origin.endsWith('.vercel.app')) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  })
);

app.options('*', cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// -------------------------------------------------------------
// 2. اتصال کش‌شده به MongoDB Atlas (بهینه برای محیط Serverless Vercel)
// -------------------------------------------------------------
let cached = global.mongooseCache;
if (!cached) {
  cached = global.mongooseCache = { conn: null, promise: null };
}

async function connectToDatabase() {
  if (cached.conn) {
    return cached.conn;
  }

  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    throw new Error('متغیر محیطی MONGODB_URI تعریف نشده است.');
  }

  if (!cached.promise) {
    cached.promise = mongoose
      .connect(mongoUri, {
        bufferCommands: false,
        maxPoolSize: 10,
        serverSelectionTimeoutMS: 8000,
      })
      .then((mongooseInstance) => mongooseInstance);
  }

  try {
    cached.conn = await cached.promise;
  } catch (err) {
    cached.promise = null;
    throw err;
  }

  return cached.conn;
}

// میدل‌ور تضمین اتصال به دیتابیس پیش از اجرای مسیرهای API
app.use('/api', async (req, res, next) => {
  try {
    await connectToDatabase();
    next();
  } catch (err) {
    console.error('MongoDB connection error:', err);
    res.status(500).json({
      success: false,
      message: 'خطا در اتصال به دیتابیس ابری MongoDB',
      error: err.message,
    });
  }
});

// -------------------------------------------------------------
// 3. تعریف مدل‌های Mongoose
// -------------------------------------------------------------
const STUDENTS_STORAGE_KEY = 'farhangian_dorm_students_prod';

const StudentSchema = new mongoose.Schema(
  {
    studentId: { type: String, required: true, unique: true, index: true },
  },
  {
    strict: false,
    timestamps: true,
  }
);

const CloudStorageSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    value: { type: mongoose.Schema.Types.Mixed, required: true },
    updatedAt: { type: Date, default: Date.now },
  },
  {
    minimize: false,
  }
);

const Student = mongoose.models.Student || mongoose.model('Student', StudentSchema);
const CloudStorage = mongoose.models.CloudStorage || mongoose.model('CloudStorage', CloudStorageSchema);

// تابع کمکی همگام‌سازی کالکشن Student با کلید کش دانشجویان در CloudStorage
async function mirrorStudentsToCloudStorage() {
  const allStudents = await Student.find({}, { _id: 0, __v: 0, createdAt: 0, updatedAt: 0 }).lean();
  await CloudStorage.findOneAndUpdate(
    { key: STUDENTS_STORAGE_KEY },
    { value: allStudents, updatedAt: new Date() },
    { upsert: true, new: true }
  );
  return allStudents;
}

// -------------------------------------------------------------
// 4. مسیرهای همگام‌سازی سراسری (/api/sync)
// -------------------------------------------------------------
app.get('/api/sync', async (req, res) => {
  try {
    const records = await CloudStorage.find({}).lean();
    const payload = {};
    for (const item of records) {
      if (item && item.key) {
        payload[item.key] = item.value;
      }
    }
    res.status(200).json(payload);
  } catch (err) {
    console.error('GET /api/sync error:', err);
    res.status(500).json({ success: false, message: 'خطا در دریافت اطلاعات از دیتابیس ابری' });
  }
});

app.post('/api/sync', async (req, res) => {
  try {
    const { key, value } = req.body;
    if (!key || value === undefined) {
      return res.status(400).json({ success: false, message: 'فیلدهای key و value الزامی هستند.' });
    }

    await CloudStorage.findOneAndUpdate(
      { key },
      { value, updatedAt: new Date() },
      { upsert: true, new: true }
    );

    // در صورت تغییر لیست کامل دانشجویان، کالکشن Student نیز به‌روزرسانی و همگام شود
    if (key === STUDENTS_STORAGE_KEY && Array.isArray(value)) {
      const validStudents = value.filter((s) => s && s.studentId);
      const incomingIds = validStudents.map((s) => String(s.studentId));

      if (validStudents.length > 0) {
        const bulkOps = validStudents.map((st) => {
          const cleanStudent = { ...st };
          delete cleanStudent._id;
          delete cleanStudent.__v;
          return {
            updateOne: {
              filter: { studentId: String(st.studentId) },
              update: { $set: cleanStudent },
              upsert: true,
            },
          };
        });
        await Student.bulkWrite(bulkOps);
      }

      // حذف دانشجویانی که در لیست جدید وجود ندارند
      await Student.deleteMany({ studentId: { $nin: incomingIds } });
    }

    res.status(200).json({ success: true, key, updatedAt: new Date() });
  } catch (err) {
    console.error('POST /api/sync error:', err);
    res.status(500).json({ success: false, message: 'خطا در ذخیره‌سازی داده در دیتابیس ابری' });
  }
});

// -------------------------------------------------------------
// 5. مسیرهای اختصاصی مدیریت دانشجویان (/api/students)
// -------------------------------------------------------------
app.get('/api/students', async (req, res) => {
  try {
    const students = await Student.find({}, { _id: 0, __v: 0 }).lean();
    res.status(200).json(students);
  } catch (err) {
    console.error('GET /api/students error:', err);
    res.status(500).json({ success: false, message: 'خطا در دریافت لیست دانشجویان' });
  }
});

app.post('/api/students', async (req, res) => {
  try {
    const studentData = { ...req.body };
    if (!studentData.studentId) {
      return res.status(400).json({ success: false, message: 'شماره دانشجویی (studentId) الزامی است.' });
    }

    delete studentData._id;
    delete studentData.__v;

    const savedStudent = await Student.findOneAndUpdate(
      { studentId: String(studentData.studentId) },
      { $set: studentData },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();

    await mirrorStudentsToCloudStorage();

    res.status(201).json({ success: true, student: savedStudent });
  } catch (err) {
    console.error('POST /api/students error:', err);
    res.status(500).json({ success: false, message: 'خطا در ثبت دانشجو', error: err.message });
  }
});

app.put('/api/students/:studentId', async (req, res) => {
  try {
    const { studentId } = req.params;
    const updates = { ...req.body };
    delete updates._id;
    delete updates.__v;

    const updatedStudent = await Student.findOneAndUpdate(
      { studentId: String(studentId) },
      { $set: updates },
      { new: true }
    ).lean();

    if (!updatedStudent) {
      return res.status(404).json({ success: false, message: 'دانشجو یافت نشد.' });
    }

    await mirrorStudentsToCloudStorage();

    res.status(200).json({ success: true, student: updatedStudent });
  } catch (err) {
    console.error('PUT /api/students/:studentId error:', err);
    res.status(500).json({ success: false, message: 'خطا در ویرایش اطلاعات دانشجو' });
  }
});

app.delete('/api/students/:studentId', async (req, res) => {
  try {
    const { studentId } = req.params;
    const deleted = await Student.findOneAndDelete({ studentId: String(studentId) }).lean();

    if (!deleted) {
      return res.status(404).json({ success: false, message: 'دانشجو برای حذف یافت نشد.' });
    }

    await mirrorStudentsToCloudStorage();

    res.status(200).json({ success: true, message: 'دانشجو با موفقیت حذف شد.' });
  } catch (err) {
    console.error('DELETE /api/students/:studentId error:', err);
    res.status(500).json({ success: false, message: 'خطا در حذف دانشجو' });
  }
});

// مسیر سلامت سرور
app.get(['/', '/api/health'], (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'khabgah-api',
    database: 'MongoDB Atlas',
    timestamp: new Date().toISOString(),
  });
});

// سازگاری با اجرای محلی و Serverless Vercel
if (require.main === module) {
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

module.exports = app;
