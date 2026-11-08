/* Vercel serverless entry — wraps the Express app for /api/* routes.
   Static files come from public/ via Vercel's CDN. */

"use strict";

const app = require("../server");

module.exports = app;
