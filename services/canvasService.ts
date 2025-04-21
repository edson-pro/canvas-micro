import apiClient, { CANVAS_API_URL } from "../lib/canvasClient";

const ACCOUNT_ID = 1;

// Handle rate limiting by implementing exponential backoff
const retryRequest = async (request, retries = 3, delay = 1000) => {
  try {
    return await request();
  } catch (error) {
    // Handle rate limiting (429) specifically
    if (error.response && error.response.status === 429 && retries > 0) {
      // Get retry-after header or use default delay
      const retryAfter = error.response.headers["retry-after"]
        ? parseInt(error.response.headers["retry-after"]) * 1000
        : delay;

      console.log(`Rate limited by Canvas. Retrying after ${retryAfter}ms...`);

      // Wait for the specified time
      await new Promise((resolve) => setTimeout(resolve, retryAfter));

      // Retry with exponential backoff
      return retryRequest(request, retries - 1, delay * 2);
    }

    throw error;
  }
};

/**
 * Creates or updates a student in Canvas
 * @param {Object} student - Student object from IMS
 * @returns {Object} Canvas user response
 */
export const createStudent = async (student) => {
  try {
    const { data } = await retryRequest(
      () =>
        apiClient.get(
          `/accounts/${ACCOUNT_ID}/users?search_term=${student.email}`
        ),
      0
    );

    const existing = data[0];

    if (existing) {
      const updateResponse = await retryRequest(() =>
        apiClient.put(`/users/${existing.id}`, {
          user: {
            name: `${student.family_name} ${student.first_name}`,
            short_name: student.first_name,
            sortable_name: `${student.first_name}, ${student.family_name}`,
            // sis_user_id: student.Identification,
          },
        })
      );

      return updateResponse.data;
    } else {
      const obj = {
        user: {
          name: `${student.family_name} ${student.first_name}`,
          short_name: student.first_name,
          sortable_name: `${student.first_name}, ${student.family_name}`,
          terms_of_use: true,
          skip_registration: true,
        },
        pseudonym: {
          unique_id: student.email,
          sis_user_id: student.Identification,
          send_confirmation: false,
        },
        communication_channel: {
          type: "email",
          address: student.email,
          skip_confirmation: true,
        },
      };

      const createResponse = await retryRequest(() =>
        apiClient.post(`/accounts/${ACCOUNT_ID}/users`, obj)
      );
      return createResponse.data;
    }
  } catch (error) {
    console.error(
      `Canvas API Error:`,
      JSON.stringify(error.response?.data?.errors, null, 2) || error.message
    );
    throw Error(`Failed to sync student -> ${student.email}`);
  }
};

/**
 * Creates or updates a course in Canvas
 * @param {Object} course - Course object from IMS
 * @returns {Object} Canvas course response
 */
export const createOrUpdateCourse = async (course) => {
  try {
    const sis_course_id = course.module_code;

    // Try to get course by SIS ID
    try {
      const response = await retryRequest(() =>
        apiClient.get(
          `/accounts/${ACCOUNT_ID}/courses/sis_course_id:${sis_course_id}`,
          {
            params: { include: ["term"] },
          }
        )
      );

      if (response.data && response.data.id) {
        // Update existing course
        const updateResponse = await retryRequest(() =>
          apiClient.put(`/courses/${response.data.id}`, {
            course: {
              name: course.name,
              course_code: course.code,
              start_at: course.startDate,
              end_at: course.endDate,
              license: "private",
              is_public: false,
              public_syllabus: false,
              public_syllabus_to_auth: false,
            },
          })
        );
        return updateResponse.data;
      }
    } catch (error) {
      // Course doesn't exist, will create below
      if (error.response && error.response.status !== 404) {
        throw error;
      }
    }

    // Create new course in Canvas
    const createResponse = await retryRequest(() =>
      apiClient.post(`/accounts/${ACCOUNT_ID}/courses`, {
        course: {
          name: course.name,
          course_code: course.module_code,
          sis_course_id: sis_course_id,
          start_at: course.startDate,
          end_at: course.endDate,
          license: "private",
          is_public: false,
          public_syllabus: false,
          public_syllabus_to_auth: false,
        },
      })
    );

    return createResponse.data;
  } catch (error) {
    console.error("Canvas API Error:", error.response?.data || error.message);
    throw new Error(`Failed to sync course to Canvas: ${error.message}`);
  }
};

/**
 * Gets a course by ID from Canvas
 * @param {string|number} courseId - Canvas course ID
 * @returns {Object} Canvas course response
 */
export const getCourseById = async (courseId) => {
  try {
    const response = await retryRequest(() =>
      apiClient.get(`/courses/${courseId}`, {
        params: {
          include: ["term", "teachers", "total_students"],
        },
      })
    );
    return response.data;
  } catch (error) {
    console.error("Canvas API Error:", error.response?.data || error.message);
    throw new Error(`Failed to get course from Canvas: ${error.message}`);
  }
};

/**
 * Gets assignments for a course from Canvas
 * @param {string|number} courseId - Canvas course ID
 * @returns {Array} Array of Canvas assignment objects
 */
export const getAssignmentsByCourse = async (courseId) => {
  try {
    // Get all assignments (paginated)
    const assignments = [];
    let url = `/courses/${courseId}/assignments`;
    let hasMore = true;

    while (hasMore) {
      const response = await retryRequest(() =>
        apiClient.get(url, {
          params: {
            per_page: 50,
            include: ["submission"],
          },
        })
      );

      // @ts-ignore
      assignments.push(...response.data);

      // Check if there are more pages
      const linkHeader = response.headers.link;
      if (linkHeader && linkHeader.includes('rel="next"')) {
        // Extract next URL from link header
        const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
        if (match && match[1]) {
          url = match[1].replace(CANVAS_API_URL, "");
        } else {
          hasMore = false;
        }
      } else {
        hasMore = false;
      }
    }

    return assignments;
  } catch (error) {
    console.error("Canvas API Error:", error.response?.data || error.message);
    throw new Error(`Failed to get assignments from Canvas: ${error.message}`);
  }
};

/**
 * Gets enrollments for a course from Canvas
 * @param {string|number} courseId - Canvas course ID
 * @param {string} type - Enrollment type (student, teacher, ta)
 * @returns {Array} Array of Canvas enrollment objects
 */
export const getEnrollmentsByCourse = async (courseId, type = null) => {
  try {
    const enrollments = [];
    let url = `/courses/${courseId}/enrollments`;
    let hasMore = true;

    // Set up query parameters
    const params = {
      per_page: 50,
      include: ["user", "section"],
    };

    if (type) {
      // @ts-ignore
      params.type = `${type}Enrollment`;
    }

    while (hasMore) {
      const response = await retryRequest(() => apiClient.get(url, { params }));
      // @ts-ignore
      enrollments.push(...response.data);

      // Check if there are more pages
      const linkHeader = response.headers.link;
      if (linkHeader && linkHeader.includes('rel="next"')) {
        // Extract next URL from link header
        const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
        if (match && match[1]) {
          url = match[1].replace(CANVAS_API_URL, "");
        } else {
          hasMore = false;
        }
      } else {
        hasMore = false;
      }
    }

    return enrollments;
  } catch (error) {
    console.error("Canvas API Error:", error.response?.data || error.message);
    throw new Error(`Failed to get enrollments from Canvas: ${error.message}`);
  }
};

/**
 * Enrolls a user in a course
 * @param {string|number} courseId - Canvas course ID
 * @param {string|number} userId - Canvas user ID
 * @param {string} role - Enrollment role (student, teacher, ta)
 * @returns {Object} Canvas enrollment response
 */
export const enrollUserInCourse = async (
  courseId,
  userId,
  role = "student"
) => {
  try {
    const response = await retryRequest(() =>
      apiClient.post(`/courses/${courseId}/enrollments`, {
        enrollment: {
          user_id: userId,
          type: `${role}Enrollment`,
          enrollment_state: "active",
          notify: false,
        },
      })
    );

    return response.data;
  } catch (error) {
    console.error("Canvas API Error:", error.response?.data || error.message);
    throw new Error(`Failed to enroll user in Canvas course: ${error.message}`);
  }
};

/**
 * Creates or updates an assignment in Canvas
 * @param {string|number} courseId - Canvas course ID
 * @param {Object} assignment - Assignment data
 * @returns {Object} Canvas assignment response
 */
export const createOrUpdateAssignment = async (courseId, assignment) => {
  try {
    if (assignment.canvas_id) {
      // Update existing assignment
      const response = await retryRequest(() =>
        apiClient.put(
          `/courses/${courseId}/assignments/${assignment.canvas_id}`,
          {
            assignment: {
              name: assignment.name,
              description: assignment.description,
              points_possible: assignment.points_possible,
              due_at: assignment.due_date,
              published: true,
            },
          }
        )
      );
      return response.data;
    } else {
      // Create new assignment
      const response = await retryRequest(() =>
        apiClient.post(`/courses/${courseId}/assignments`, {
          assignment: {
            name: assignment.name,
            description: assignment.description,
            points_possible: assignment.points_possible,
            due_at: assignment.due_date,
            published: true,
          },
        })
      );
      return response.data;
    }
  } catch (error) {
    console.error("Canvas API Error:", error.response?.data || error.message);
    throw new Error(
      `Failed to create/update assignment in Canvas: ${error.message}`
    );
  }
};

/**
 * Gets sections for a course from Canvas
 * @param {string|number} courseId - Canvas course ID
 * @returns {Array} Array of Canvas section objects
 */
export const getSectionsByCourse = async (courseId) => {
  try {
    const response = await retryRequest(() =>
      apiClient.get(`/courses/${courseId}/sections`, {
        params: { include: ["students"] },
      })
    );
    return response.data;
  } catch (error) {
    console.error("Canvas API Error:", error.response?.data || error.message);
    throw new Error(`Failed to get sections from Canvas: ${error.message}`);
  }
};

/**
 * Gets course progress information
 * @param {string|number} courseId - Canvas course ID
 * @param {string|number} userId - Canvas user ID
 * @returns {Object} Course progress data
 */
export const getCourseProgress = async (courseId, userId) => {
  try {
    const response = await retryRequest(() =>
      apiClient.get(`/courses/${courseId}/users/${userId}/progress`)
    );
    return response.data;
  } catch (error) {
    console.error("Canvas API Error:", error.response?.data || error.message);
    throw new Error(
      `Failed to get course progress from Canvas: ${error.message}`
    );
  }
};
