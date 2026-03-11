const express = require("express")
const session = require("express-session")
const passport = require("passport")
const GoogleStrategy = require("passport-google-oauth20").Strategy
const crypto = require("crypto")
const path = require("path")

const app = express()
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

const PORT = process.env.PORT || 3000
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET
const SESSION_SECRET =
  process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex")
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`
// Comma-separated list of allowed Google emails. If empty, any authenticated Google user is allowed.
const ALLOWED_EMAILS = (process.env.ALLOWED_EMAILS || "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean)

const HUBSPOT_TOKEN = process.env.HUBSPOT_ACCESS_TOKEN
const HUBSPOT_APPS_TOKEN = process.env.HUBSPOT_APPS_TOKEN
const APPS_SCRIPT_URL =
  process.env.APPS_SCRIPT_URL ||
  "https://script.google.com/macros/s/AKfycbyI7MOO8rNDduy5gGweUIP7kVXBDFEqF4KA8QdMGEH6Whkc5IKdamVplZLVtmYoOFNF/exec"
const APPS_SCRIPT_SECRET = process.env.APPS_SCRIPT_SECRET || "bw-gen-2026"

// Applications custom object type ID
const APPLICATIONS_OBJECT_TYPE = "2-38227027"

// Pipelines to include
const PIPELINE_IDS = [
  "4483329", // Staff Onboarding (Outsource)
  "16984077", // Staff Onboarding and Offboarding (BW Internal)
]

// Ticket properties to fetch from HubSpot
const TICKET_PROPERTIES = [
  "subject",
  "createdate",
  "hs_pipeline_stage",
  "synced__submitted_legal_first_name",
  "synced__submitted_legal_last_name",
  "synced__staff_address_1_house",
  "synced__staff_address_2_neighborhood",
  "synced__staff_address_3_city",
  "synced__staff_address_4_state",
  "synced__staff_address_5_country",
  "synced__staff_address_6_postal_code",
  "assignment_country",
  "onboarding_date",
  "role",
  "client",
  "number_of_paid_hours",
  "job_description",
  "contract_sending_date",
  "hourly_rate",
  "staff_hourly_monthly_rate_currency",
  "daily_work_schedule",
  "weekly_work_schedule",
]

// Map of template placeholders to HubSpot property names
const FIELD_MAP = {
  "Date Contract Sent": "contract_sending_date",
  "Synced - Submitted Legal First Name": "synced__submitted_legal_first_name",
  "Synced - Submitted Legal Last Name": "synced__submitted_legal_last_name",
  "Synced - Staff Address 1 House": "synced__staff_address_1_house",
  "Synced - Staff Address 2 Neighborhood":
    "synced__staff_address_2_neighborhood",
  "Synced - Staff Address 3 City": "synced__staff_address_3_city",
  "Synced - Staff Address 4 State": "synced__staff_address_4_state",
  "Synced - Staff Address 5 Country": "synced__staff_address_5_country",
  "Synced - Staff Address 6 Postal Code": "synced__staff_address_6_postal_code",
  "Onboarding Date": "onboarding_date",
  Role: "role",
  Client: "client",
  "Number of Contracted Hours": "number_of_paid_hours",
  "Job Description": "job_description",
  "Hourly Rate": "hourly_rate",
  "Staff Hourly/Monthly Rate Currency": "staff_hourly_monthly_rate_currency",
}

// Pipeline stage labels (fetched dynamically, cached)
let stageLabels = {}

// In-memory store: last generated contract per ticket { ticketId: { docUrl, docId, title, generatedAt } }
const lastContracts = {}

// In-memory store: last generated resume per application { appId: { docUrl, docId, title, generatedAt } }
const lastResumes = {}

// --- Session & Passport ---
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  }),
)

app.use(passport.initialize())
app.use(passport.session())

passport.use(
  new GoogleStrategy(
    {
      clientID: GOOGLE_CLIENT_ID,
      clientSecret: GOOGLE_CLIENT_SECRET,
      callbackURL: `${BASE_URL}/auth/google/callback`,
    },
    (accessToken, refreshToken, profile, done) => {
      const email = profile.emails?.[0]?.value?.toLowerCase()
      if (!email) return done(null, false, { message: "No email from Google" })
      return done(null, { email, name: profile.displayName })
    },
  ),
)

passport.serializeUser((user, done) => done(null, user))
passport.deserializeUser((user, done) => done(null, user))

// --- Auth ---
function isAllowedEmail(email) {
  if (!email) return false
  if (ALLOWED_EMAILS.length === 0) return true // no restriction set — allow any Google user
  return ALLOWED_EMAILS.includes(email.toLowerCase())
}

function requireAuth(req, res, next) {
  if (!req.user) {
    req.session.returnTo = req.originalUrl
    return res.redirect("/login")
  }
  if (!isAllowedEmail(req.user.email)) {
    return res.redirect("/login?error=unauthorized")
  }
  return next()
}

// Alias for contracts and resumes (both use the same Google auth)
const requireContractsAuth = requireAuth
const requireResumesAuth = requireAuth

// X-Robots-Tag header on all responses
app.use((req, res, next) => {
  res.setHeader("X-Robots-Tag", "noindex, nofollow")
  next()
})

// Robots.txt - block all crawlers
app.get("/robots.txt", (req, res) => {
  res.type("text/plain")
  res.send("User-agent: *\nDisallow: /\n")
})

// Login page
app.get("/login", (req, res) => {
  if (req.user && isAllowedEmail(req.user.email)) {
    return res.redirect(req.session.returnTo || "/")
  }
  const error =
    req.query.error === "unauthorized"
      ? '<p class="login-error">Your Google account is not authorized to access this app.</p>'
      : req.query.error
        ? '<p class="login-error">Sign-in failed. Please try again.</p>'
        : ""
  res.send(buildLoginPage(error))
})

function buildLoginPage(error) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex, nofollow">
  <title>Sign In - Bruntwork</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #f5f5f5; color: #333; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .login-box { background: #fff; border-radius: 12px; padding: 40px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); width: 360px; text-align: center; }
    .login-box h1 { font-size: 20px; font-weight: 600; margin-bottom: 8px; }
    .login-box p.sub { color: #666; font-size: 14px; margin-bottom: 28px; }
    .google-btn { display: inline-flex; align-items: center; justify-content: center; gap: 12px; width: 100%; padding: 10px 20px; background: #fff; border: 1px solid #ddd; border-radius: 6px; font-size: 14px; font-weight: 500; color: #333; text-decoration: none; cursor: pointer; box-shadow: 0 1px 3px rgba(0,0,0,0.08); transition: background 0.15s, box-shadow 0.15s; }
    .google-btn:hover { background: #f8f8f8; box-shadow: 0 2px 6px rgba(0,0,0,0.12); }
    .login-error { color: #d32f2f; font-size: 13px; margin-bottom: 16px; }
  </style>
</head>
<body>
  <div class="login-box">
    <h1>Bruntwork</h1>
    <p class="sub">Sign in to continue</p>
    ${error}
    <a href="/auth/google" class="google-btn">
      <svg width="18" height="18" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
        <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.08 17.74 9.5 24 9.5z"/>
        <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
        <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
        <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.31-8.16 2.31-6.26 0-11.57-3.58-13.46-8.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
      </svg>
      Sign in with Google
    </a>
  </div>
</body>
</html>`
}

// Start Google OAuth
app.get(
  "/auth/google",
  passport.authenticate("google", { scope: ["email", "profile"] }),
)

// Google OAuth callback
app.get(
  "/auth/google/callback",
  passport.authenticate("google", { failureRedirect: "/login?error=1" }),
  (req, res) => {
    if (!isAllowedEmail(req.user?.email)) {
      req.logout(() => {})
      return res.redirect("/login?error=unauthorized")
    }
    const returnTo = req.session.returnTo || "/"
    delete req.session.returnTo
    req.session.save(() => {
      res.redirect(returnTo)
    })
  },
)

app.get("/logout", (req, res) => {
  req.logout(() => {
    req.session.destroy()
    res.redirect("/login")
  })
})

// Serve static assets (CSS, JS) without auth
app.use((req, res, next) => {
  const ext = path.extname(req.path)
  if (ext && ext !== ".html") {
    return express.static(path.join(__dirname, "public"))(req, res, next)
  }
  next()
})

// Contracts page
app.get("/", requireContractsAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"))
})

// Resumes page
app.get("/resumes.html", requireResumesAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "resumes.html"))
})

// --- HubSpot API helpers ---
async function hubspotFetch(url, options = {}) {
  const resp = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${HUBSPOT_TOKEN}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  })
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`HubSpot API error ${resp.status}: ${text}`)
  }
  return resp.json()
}

async function hubspotAppsFetch(url, options = {}) {
  const resp = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${HUBSPOT_APPS_TOKEN}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  })
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`HubSpot API error ${resp.status}: ${text}`)
  }
  return resp.json()
}

function stripCodeFences(html) {
  if (!html) return html
  // Remove markdown code fences: ```html ... ``` or ``` ... ```
  return html
    .replace(/^```(?:html)?\s*\n?/i, "")
    .replace(/\n?```\s*$/, "")
    .trim()
}

async function fetchPipelineStages() {
  if (Object.keys(stageLabels).length > 0) return stageLabels
  try {
    for (const pid of PIPELINE_IDS) {
      const data = await hubspotFetch(
        `https://api.hubapi.com/crm/v3/pipelines/tickets/${pid}/stages`,
      )
      for (const stage of data.results) {
        stageLabels[stage.id] = stage.label
      }
    }
  } catch (err) {
    console.error("Failed to fetch pipeline stages:", err.message)
  }
  return stageLabels
}

// --- API Routes ---

// GET /api/tickets - list tickets from Staff Onboarding pipeline
app.get("/api/tickets", requireContractsAuth, async (req, res) => {
  try {
    const after = req.query.after || undefined
    const limit = Math.min(parseInt(req.query.limit) || 20, 100)
    const query = req.query.q || ""

    await fetchPipelineStages()

    const body = {
      filterGroups: [
        {
          filters: [
            {
              propertyName: "hs_pipeline",
              operator: "IN",
              values: PIPELINE_IDS,
            },
          ],
        },
      ],
      properties: [
        "subject",
        "createdate",
        "hs_pipeline_stage",
        "role",
        "client",
        "onboarding_date",
      ],
      sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
      limit,
    }
    if (query) body.query = query
    if (after) body.after = after

    const data = await hubspotFetch(
      "https://api.hubapi.com/crm/v3/objects/tickets/search",
      { method: "POST", body: JSON.stringify(body) },
    )

    const tickets = data.results.map((t) => ({
      id: t.id,
      subject: t.properties.subject,
      createdate: t.properties.createdate,
      stage:
        stageLabels[t.properties.hs_pipeline_stage] ||
        t.properties.hs_pipeline_stage,
      role: t.properties.role,
      client: t.properties.client,
      onboardingDate: t.properties.onboarding_date,
      hubspotUrl: `https://app.hubspot.com/contacts/8513837/record/0-5/${t.id}`,
    }))

    res.json({
      tickets,
      total: data.total,
      paging: data.paging,
    })
  } catch (err) {
    console.error("Error fetching tickets:", err)
    res.status(500).json({ error: err.message })
  }
})

// POST /api/generate-contract - generate a Google Doc from a ticket
app.post("/api/generate-contract", requireContractsAuth, async (req, res) => {
  try {
    const { ticketId, templateDocId } = req.body
    if (!ticketId)
      return res.status(400).json({ error: "ticketId is required" })
    if (!templateDocId)
      return res.status(400).json({ error: "templateDocId is required" })

    // 1. Fetch full ticket details from HubSpot
    const url = `https://api.hubapi.com/crm/v3/objects/tickets/${ticketId}?properties=${TICKET_PROPERTIES.join(",")}`
    const ticket = await hubspotFetch(url)
    const props = ticket.properties

    // 2. Build staff name and title
    const staffName =
      [
        props.synced__submitted_legal_first_name,
        props.synced__submitted_legal_last_name,
      ]
        .filter(Boolean)
        .join(" ") ||
      props.subject?.split(",")[0] ||
      "Unknown"

    const copyTitle = `Independent Contractor Agreement - ${staffName}`

    // 3. Build replacements map
    const replacements = {}
    for (const [placeholder, propName] of Object.entries(FIELD_MAP)) {
      let value = props[propName] || ""

      if (placeholder === "Synced - Staff Address 5 Country" && !value) {
        value = props.assignment_country || ""
      }
      if (
        (placeholder === "Date Contract Sent" ||
          placeholder === "Onboarding Date") &&
        value
      ) {
        value = formatDate(value)
      }
      if (placeholder === "Job Description" && value) {
        value = stripHtml(value)
      }

      replacements[placeholder] = value
    }

    // 4. Call Apps Script web app to copy template and apply replacements
    const scriptResp = await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret: APPS_SCRIPT_SECRET,
        title: copyTitle,
        templateId: templateDocId,
        replacements,
      }),
      redirect: "follow",
    })

    const scriptText = await scriptResp.text()
    let scriptData
    try {
      scriptData = JSON.parse(scriptText)
    } catch {
      throw new Error(
        `Apps Script returned invalid JSON: ${scriptText.substring(0, 200)}`,
      )
    }

    if (scriptData.error) {
      throw new Error(`Apps Script error: ${scriptData.error}`)
    }

    const result = {
      docUrl: scriptData.docUrl,
      docId: scriptData.docId,
      title: scriptData.title,
    }

    // Store as last generated contract for this ticket
    lastContracts[ticketId] = {
      ...result,
      generatedAt: new Date().toISOString(),
    }

    res.json(result)
  } catch (err) {
    console.error("Error generating contract:", err)
    res.status(500).json({ error: err.message })
  }
})

// GET /api/last-contracts - get last generated contracts for given ticket IDs
app.get("/api/last-contracts", requireContractsAuth, (req, res) => {
  const ids = (req.query.ids || "").split(",").filter(Boolean)
  const result = {}
  for (const id of ids) {
    if (lastContracts[id]) {
      result[id] = lastContracts[id]
    }
  }
  res.json(result)
})

// --- Applications / Resumes API Routes ---

// GET /api/applications - list applications with generate_formatted_resume = Generate
app.get("/api/applications", requireResumesAuth, async (req, res) => {
  try {
    const after = req.query.after || undefined
    const limit = Math.min(parseInt(req.query.limit) || 20, 100)
    const query = req.query.q || ""

    const body = {
      filterGroups: [
        {
          filters: [
            {
              propertyName: "generate_formatted_resume",
              operator: "EQ",
              value: "Generate",
            },
            {
              propertyName: "ai_formatted_resume_code",
              operator: "HAS_PROPERTY",
            },
          ],
        },
      ],
      properties: [
        "first_name",
        "last_name",
        "client__cloned_",
        "role__cloned_",
        "createdate",
        "generate_formatted_resume",
      ],
      sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
      limit,
    }
    if (query) body.query = query
    if (after) body.after = after

    const data = await hubspotAppsFetch(
      `https://api.hubapi.com/crm/v3/objects/${APPLICATIONS_OBJECT_TYPE}/search`,
      { method: "POST", body: JSON.stringify(body) },
    )

    const applications = data.results.map((a) => {
      const firstName = a.properties.first_name || ""
      const lastName = a.properties.last_name || ""
      const candidateName =
        [firstName, lastName].filter(Boolean).join(" ") || "-"
      return {
        id: a.id,
        candidateName,
        clientName: a.properties["client__cloned_"] || "-",
        role: a.properties["role__cloned_"] || "-",
        createdate: a.properties.createdate,
        hubspotUrl: `https://app.hubspot.com/contacts/8513837/record/${APPLICATIONS_OBJECT_TYPE}/${a.id}`,
      }
    })

    res.json({
      applications,
      total: data.total,
      paging: data.paging,
    })
  } catch (err) {
    console.error("Error fetching applications:", err)
    res.status(500).json({ error: err.message })
  }
})

// POST /api/generate-resume - generate a formatted Google Doc from application HTML
app.post("/api/generate-resume", requireResumesAuth, async (req, res) => {
  try {
    const { appId } = req.body
    if (!appId) return res.status(400).json({ error: "appId is required" })

    // 1. Fetch application with HTML content
    const url = `https://api.hubapi.com/crm/v3/objects/${APPLICATIONS_OBJECT_TYPE}/${appId}?properties=first_name,last_name,client__cloned_,role__cloned_,ai_formatted_resume_code`
    const appData = await hubspotAppsFetch(url)
    const props = appData.properties

    let htmlContent = props.ai_formatted_resume_code
    if (!htmlContent) {
      return res
        .status(400)
        .json({
          error: "No AI Formatted Resume Code found for this application",
        })
    }

    // Strip markdown code fences if present
    htmlContent = stripCodeFences(htmlContent)

    const firstName = props.first_name || ""
    const lastName = props.last_name || ""
    const candidateName =
      [firstName, lastName].filter(Boolean).join(" ") || "Unknown"
    const title = `Formatted Resume - ${candidateName}`

    // 2. Call Apps Script to convert HTML to Google Doc
    const scriptResp = await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret: APPS_SCRIPT_SECRET,
        action: "htmlToDoc",
        title,
        htmlContent,
      }),
      redirect: "follow",
    })

    const scriptText = await scriptResp.text()
    let scriptData
    try {
      scriptData = JSON.parse(scriptText)
    } catch {
      throw new Error(
        `Apps Script returned invalid JSON: ${scriptText.substring(0, 200)}`,
      )
    }

    if (scriptData.error) {
      throw new Error(`Apps Script error: ${scriptData.error}`)
    }

    const result = {
      docUrl: scriptData.docUrl,
      docId: scriptData.docId,
      title: scriptData.title,
    }

    // Store as last generated resume for this application
    lastResumes[appId] = { ...result, generatedAt: new Date().toISOString() }

    res.json(result)
  } catch (err) {
    console.error("Error generating resume:", err)
    res.status(500).json({ error: err.message })
  }
})

// GET /api/last-resumes - get last generated resumes for given application IDs
app.get("/api/last-resumes", requireResumesAuth, (req, res) => {
  const ids = (req.query.ids || "").split(",").filter(Boolean)
  const result = {}
  for (const id of ids) {
    if (lastResumes[id]) {
      result[id] = lastResumes[id]
    }
  }
  res.json(result)
})

// --- Helpers ---
function formatDate(dateStr) {
  try {
    const d = new Date(dateStr)
    return d.toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    })
  } catch {
    return dateStr
  }
}

function stripHtml(html) {
  return html
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})
