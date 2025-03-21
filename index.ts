import express from "express";
import cors from "cors";
import morgan from "morgan";
import dotenv from "dotenv";
import axios from "axios";
import mysql from "mysql2/promise";
import { createOrUpdateCourse, createStudent } from "./services/canvasService";
import apiClient from "./lib/canvasClient";

const CANVAS_API_KEY = `1941~GZQMCk7vtNaxzU6fefZGN2tvRGX2D3PxyGc3BTFJt7RwxRHxK3XNLw6fYhVRJJJA`;
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
  AND (email IS NOT NULL AND email <> '' AND Identification IS NOT NULL AND email <> '')`
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
app.post("/sync-timetable", async (req, res) => {
  try {
    const timetable_id = req?.body?.timetable_id;

    if (!timetable_id) {
      return res.status(400).json({
        success: false,
        message: "Timetable ID is required",
      });
    }

    const [timetableRes] = await db.execute(
      `SELECT *
   FROM tbl_module_time_table
   INNER JOIN modules ON tbl_module_time_table.module_Id = modules.module_id
   WHERE time_table_Id = ?`,
      [timetable_id]
    );

    const [studentsRes] = await db.execute(
      `SELECT tbl_personal_ug.reg_no AS REG_NUMBER,tbl_personal_ug.fname AS FIRST_NAME,tbl_personal_ug.fname AS middlename,tbl_personal_ug.lname AS FAMILY_NAME,tbl_personal_ug.email1 AS EMAIL,tbl_campus.camp_full_name AS CAMPUS,
tbl_specialization.splz_full_name AS SPECIALIZATION 
FROM tbl_personal_ug 
INNER JOIN tbl_att_stud_mdl_reg ON tbl_personal_ug.reg_no=tbl_att_stud_mdl_reg.reg_no 
INNER JOIN tbl_module_time_table_details ON tbl_att_stud_mdl_reg.det_Id=tbl_module_time_table_details.det_Id 
INNER JOIN tbl_module_time_table ON tbl_module_time_table_details.time_table_Id=tbl_module_time_table.time_table_Id 
INNER JOIN tbl_register_program_ug ON tbl_att_stud_mdl_reg.reg_prg_id=tbl_register_program_ug.reg_prg_id 
INNER JOIN tbl_campus ON tbl_register_program_ug.camp_id=tbl_campus.camp_id 
INNER JOIN tbl_specialization ON tbl_register_program_ug.splz_id=tbl_specialization.splz_id 
WHERE tbl_att_stud_mdl_reg.status_Id=? AND tbl_module_time_table_details.time_table_Id=? 
ORDER BY tbl_personal_ug.reg_no ASC`,
      [1, timetable_id]
    );

    const data = {
      name: timetableRes[0].module_name,
      module_code: timetableRes[0].module_code,
      time_table_Id: timetableRes[0].time_table_Id,
      startDate: timetableRes[0].start_date,
      endDate: timetableRes[0].end_date,
      code: timetableRes[0].module_code,
      // @ts-ignore
      students: studentsRes?.map((e) => {
        return {
          reg_no: e["REG_NUMBER"],
          first_name: e["FIRST_NAME"],
          middle_name: e["middlename"],
          family_name: e["FAMILY_NAME"],
          email: e["EMAIL"],
        };
      }),
    };

    const course = await createOrUpdateCourse({
      ...data,
    });

    // update the timetable with the canvas course id
    await db.execute(
      "UPDATE tbl_module_time_table SET canvas_course_id = ? WHERE time_table_Id = ?",
      [course?.id, timetable_id]
    );

    // sync students to the canvas course
    for (const student of data.students) {
      const { data } = await apiClient.get(
        `/accounts/${ACCOUNT_ID}/users?search_term=${student?.email}`
      );

      const existing = data[0];

      if (!existing) {
        console.log(`Student not found in Canvas -> ${student?.email}`);
        continue;
      }

      await apiClient.post(`/courses/${course?.id}/enrollments`, {
        enrollment: {
          user_id: existing.id,
          type: "StudentEnrollment",
          enrollment_state: "active",
        },
      });
    }

    res.json({ ...data, course });
 
  } catch (error) {
    console.error("Error:", error.response?.status || error);
  }
});

// Routes
app.post("/sync-grades", async (req, res) => {
  try {
    const course_id = req?.body?.course_id;

    const { data: canvas_course } = await api.get(`/courses/${course_id}`);

    const { data: assignmentsGroups } = await api.get(
      `/courses/${canvas_course?.id}/assignment_groups`,
      {
        params: {
          per_page: 100,
          "include[]": ["assignments", "submission"],
        },
      }
    );

    const groups = assignmentsGroups
      .filter(
        (e) =>
          e.name.startsWith("EXAM:") ||
          e.name.startsWith("CAT:") ||
          e.name.startsWith("HA:")
      )
      .map((e) => {
        return {
          ...e,
          type: e.name.startsWith("CAT:")
            ? "CAT"
            : e.name.startsWith("EXAM:")
            ? "EXAM"
            : e.name.startsWith("HA:")
            ? "HELP_ASSISTANT"
            : "",
        };
      });

    // Step 2: Get all students
    const studentsResponse = await api.get(
      `/courses/${canvas_course?.id}/users`,
      {
        params: {
          "enrollment_type[]": "student",
          per_page: 100,
        },
      }
    );

    const students = studentsResponse.data;

    let submissions: any[] = [];
    let assignments: any[] = [];

    for (let index = 0; index < groups.length; index++) {
      const group = groups[index];

      for (const assignment of group?.assignments) {
        assignments.push(assignment);
        const submissionsResponse = await api.get(
          `/courses/${canvas_course?.id}/assignments/${assignment?.id}/submissions`,
          {
            params: {
              per_page: 100,
              "include[]": ["user"],
            },
          }
        );

        submissionsResponse?.data?.forEach((sub: any) => {
          submissions.push({ ...sub, group: group.id });
        });
      }
    }

    const studentsWithGroupsSubmitions = students.map((student) => {
      const groupsRes = groups
        .map((group) => {
          return {
            name: group.name,
            id: group.id,
            type: group.type,
            group_weight: group?.group_weight,
            submissions: submissions
              .filter((e) => e.user_id === student.id && e.group === group.id)
              .map((e) => {
                const assignment = assignments.find(
                  (a) => a.id === e?.assignment_id
                );

                return {
                  id: e.id,
                  score: e.score,
                  points_possible: assignment?.points_possible,
                };
              }),
          };
        })
        .map((group) => {
          const submissions = group.submissions;
          // Calculate total percentage
          const totalScore = submissions.reduce(
            (sum, submission) => sum + submission.score,
            0
          );
          const totalPointsPossible = submissions.reduce(
            (sum, submission) => sum + submission.points_possible,
            0
          );
          const totalPercent =
            Math.round((totalScore / totalPointsPossible) * 100 * 100) / 100;

          return {
            ...group,
            totalPercent,
          };
        });
      const cat_groups = groupsRes.filter((e) => e.type === "CAT");

      const total_cats_percentage =
        cat_groups.reduce((acc, assessment) => {
          return acc + assessment.totalPercent * assessment.group_weight;
        }, 0) /
        cat_groups.reduce(
          (acc, assessment) => acc + assessment.group_weight,
          0
        );

      const exam_groups = groupsRes.filter((e) => e.type === "EXAM");

      const total_exams_percentage =
        exam_groups.reduce((acc, assessment) => {
          return acc + assessment.totalPercent * assessment.group_weight;
        }, 0) /
        exam_groups.reduce(
          (acc, assessment) => acc + assessment.group_weight,
          0
        );

      // Calculate the total percentage
      const totalPercentage =
        groupsRes.reduce((acc, assessment) => {
          return acc + assessment.totalPercent * assessment.group_weight;
        }, 0) /
        groupsRes.reduce((acc, assessment) => acc + assessment.group_weight, 0);

      const catsPercentage = total_cats_percentage;
      const examsPercentage = total_exams_percentage;
      const catsWeight = 0.6; // 60%
      const examsWeight = 0.4; // 40%

      const cat_p = catsPercentage * catsWeight;
      const exam_p = examsPercentage * examsWeight;

      const finalPercentage = cat_p + exam_p;

      const help_assesment_marks = groupsRes?.find(
        (e) => e.type === "HELP_ASSISTANT"
      )?.totalPercent;
 

      return {
        id: student?.id,
        name: student?.name,
        regNumber: student?.name,
        groups: groupsRes,
        totalPercentage: (totalPercentage || 0).toFixed(2),
        catPercentage: (cat_p || 0).toFixed(2),
        examPercentage: (exam_p || 0).toFixed(2),
        finalPercentage: (finalPercentage || 0).toFixed(2),
        help_assesment_marks,
        status: help_assesment_marks === 100 ? "complete" : "incomplete",
      };
    });

    res.json(studentsWithGroupsSubmitions);
  } catch (error) { 
    console.error("Error:", error.response?.data);
    res.status(400).json({ error: error?.response?.data || error?.message });
  }
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
