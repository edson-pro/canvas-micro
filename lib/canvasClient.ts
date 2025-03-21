// services/canvasService.js
const axios = require("axios");

// Configure Canvas API client
export const CANVAS_API_URL =
  process.env.CANVAS_API_URL || "https://kepler.test.instructure.com/api/v1";
const CANVAS_API_TOKEN =
  process.env.CANVAS_API_TOKEN ||
  `1941~rkL48mnrzDhrQ6kW2kWXffJmza6YMmrMrPhNzwB4QmGDtvEA8xQmKGW6BT43ZCwa`;

const apiClient = axios.create({
  baseURL: CANVAS_API_URL,
  headers: {
    Authorization: `Bearer ${CANVAS_API_TOKEN}`,
    "Content-Type": "application/json",
  },
});

export default apiClient;
