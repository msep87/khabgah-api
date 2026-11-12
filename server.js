require('dotenv').config(); // خواندن اطلاعات مخفی از فایل .env
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();
app.use(cors()); 
app.use(express.json());

// گرفتن آدرس دیتابیس از فایل مخفی
const mongoURI = process.env.MONGODB_URI;

// اتصال به دیتابیس ابری
mongoose.connect(mongoURI)
  .then(() => console.log('✅ اتصال به دیتابیس ابری MongoDB با موفقیت برقرار شد'))
  .catch(err => console.log('❌ خطا در اتصال دیتابیس:', err));

// تعریف ساختار دانشجویان
const StudentSchema = new mongoose.Schema({
  fullName: String,
  studentId: String,
  fieldOfStudy: String
});
const Student = mongoose.model('Student', StudentSchema);

// مسیر (API) گرفتن لیست دانشجویان
app.get('/api/students', async (req, res) => {
  const students = await Student.find();
  res.json(students);
});

// مسیر (API) برای ثبت دانشجوی جدید
app.post('/api/students', async (req, res) => {
  try {
    const newStudent = new Student(req.body);
    await newStudent.save();
    res.json({ message: '✅ دانشجو با موفقیت در دیتابیس ذخیره شد!', student: newStudent });
  } catch (err) {
    res.status(500).json({ error: 'خطا در ثبت اطلاعات' });
  }
});

// روشن کردن سرور
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 سرور روی پورت ${PORT} روشن شد!`);
});