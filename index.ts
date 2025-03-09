import express from "express";
import cors from "cors";
import morgan from "morgan";
import dotenv from "dotenv";
import axios from "axios";
import mysql from "mysql2/promise";
import { createOrUpdateCourse, createStudent } from "./services/canvasService";

const CANVAS_API_KEY = `7~nWGxXeE3RJekY8T8MZ8YrcM6rwV8heRu26TmrMJ7GwMFUvvAHu6vfRVem89vE8eD`;
const ACCOUNT_ID = 1;

const db = mysql.createPool({
  host: "localhost",
  user: "root",
  password: "",
  database: "mis_kepler_db",
  port: 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

const api = axios.create({
  baseURL: `https://kepler.test.instructure.com/api/v1`,
  headers: {
    Authorization: `Bearer ${CANVAS_API_KEY}`,
    "Content-Type": "application/json",
  },
});

// Load environment variables
dotenv.config();

const app = express();

// Middleware
app.use(cors());
app.use(morgan("dev"));
app.use(express.json());

// Routes
app.post(
  "/sync-students",
  asyncHandler(async (req, res) => {
    try {
      // students without
      const [studentsToSyncRes] = await db.execute(
        `SELECT * 
FROM tbl_student_login 
WHERE canvas_id IS NULL 
  AND (email IS NOT NULL AND email <> '' AND Identification IS NOT NULL AND email <> '')  
LIMIT 10;`
      );

      const studentsToSync = studentsToSyncRes as any[];

      if (studentsToSync?.length === 0) {
        return res.status(200).json({
          success: true,
          message: "No students found that need syncing to Canvas",
          data: [],
        });
      }

      // Sync students to Canvas and update their IMS records with Canvas IDs
      const results = [];
      for (const student of studentsToSync) {
        const canvasStudent = await createStudent({
          ...student,
        });

        await db.execute(
          "UPDATE tbl_student_login SET canvas_id = ? WHERE id = ?",
          [canvasStudent?.id, student.id]
        );

        const [updatedStudent] = await db.execute(
          "SELECT * FROM tbl_student_login WHERE id = ?",
          [student.id]
        );

        console.log(`Succesfully synced -> ${canvasStudent?.sortable_name}`);

        // @ts-ignore
        results.push(updatedStudent[0]);
      }

      res.status(200).json({
        success: true,
        message: `Successfully synced ${results.length} students to Canvas`,
        data: results.map((e) => {
          return {
            id: e["id"],
            email: e["email"],
            first_name: e["first_name"],
            Identification: e["Identification"],
          };
        }),
      });
    } catch (error) {
      console.log(error?.response?.data);
      res.status(400).json({ error: error?.response?.data || error?.message });
    }
  })
);

// Routes
app.post("/sync-courses", async (req, res) => {
  const [coursesToSyncRes] = await db.execute(
    `SELECT * 
FROM modules 
WHERE canvas_id IS NULL  
LIMIT 10;`
  );

  const coursesToSync = coursesToSyncRes as any[];

  const results: any[] = [];

  for (const course of coursesToSync) {
    try {
      // Create or update the course in Canvas
      const canvasCourse = await createOrUpdateCourse(course);

      await db.execute("UPDATE modules SET canvas_id = ? WHERE module_id = ?", [
        canvasCourse?.id,
        course?.module_id,
      ]);

      results.push({
        success: true,
        message: `Successfully synced course: ${course.name}`,
        courseId: canvasCourse.id,
        sis_course_id: canvasCourse.sis_course_id,
        name: canvasCourse.name,
      });
    } catch (error) {
      console.error(`Failed to sync course ${course.name}:`, error);
      results.push({
        success: false,
        message: `Failed to sync course: ${course.name}`,
        error: error.message,
        course: course,
      });
    }
  }

  res.status(200).json({
    success: true,
    message: `Successfully synced ${results.length} courses to Canvas`,
    data: results,
  });
});

// Routes
app.post("/sync-grades", async (req, res) => {
  const { data: grades } = await api.get(`/courses/2489/students/submissions`);
  console.log(grades[0]?.graders?.[0]);
  res.json({ message: "Sync courses successfully" });
});

// Routes
app.get("/", (req, res) => {
  res.json({ message: "Welcome to Canvas Micro." });
});

// Start the server
const PORT = process.env.PORT || 4040;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
