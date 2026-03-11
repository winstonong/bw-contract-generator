const express = require('express');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

const PORT = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD || '1234';
const COOKIE_SECRET = process.env.COOKIE_SECRET || crypto.randomBytes(32).toString('hex');

const HUBSPOT_TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;
const HUBSPOT_APPS_TOKEN = process.env.HUBSPOT_APPS_TOKEN;
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL || 'https://script.google.com/macros/s/AKfycbxJxY9XRUfqgZ_tFmcbHnjh6pxV_vBJ4FSI5wo1oGGv6bTP-PTRezwVB9mSYtaKFt-6/exec';
const APPS_SCRIPT_SECRET = process.env.APPS_SCRIPT_SECRET || 'bw-gen-2026';

// Applications custom object type ID
const APPLICATIONS_OBJECT_TYPE = '2-38227027';

// Pipelines to include
const PIPELINE_IDS = [
  '4483329',   // Staff Onboarding (Outsource)
  '16984077',  // Staff Onboarding and Offboarding (BW Internal)
];

// Ticket properties to fetch from HubSpot
const TICKET_PROPERTIES = [
  'subject', 'createdate', 'hs_pipeline_stage',
  'synced__submitted_legal_first_name', 'synced__submitted_legal_last_name',
  'synced__staff_address_1_house', 'synced__staff_address_2_neighborhood',
  'synced__staff_address_3_city', 'synced__staff_address_4_state',
  'synced__staff_address_5_country', 'synced__staff_address_6_postal_code',
  'assignment_country',
  'onboarding_date', 'role', 'client',
  'number_of_paid_hours', 'job_description',
  'contract_sending_date', 'hourly_rate', 'staff_hourly_monthly_rate_currency',
  'daily_work_schedule', 'weekly_work_schedule'
];

// Map of template placeholders to HubSpot property names
const FIELD_MAP = {
  'Date Contract Sent': 'contract_sending_date',
  'Synced - Submitted Legal First Name': 'synced__submitted_legal_first_name',
  'Synced - Submitted Legal Last Name': 'synced__submitted_legal_last_name',
  'Synced - Staff Address 1 House': 'synced__staff_address_1_house',
  'Synced - Staff Address 2 Neighborhood': 'synced__staff_address_2_neighborhood',
  'Synced - Staff Address 3 City': 'synced__staff_address_3_city',
  'Synced - Staff Address 4 State': 'synced__staff_address_4_state',
  'Synced - Staff Address 5 Country': 'synced__staff_address_5_country',
  'Synced - Staff Address 6 Postal Code': 'synced__staff_address_6_postal_code',
  'Onboarding Date': 'onboarding_date',
  'Role': 'role',
  'Client': 'client',
  'Number of Contracted Hours': 'number_of_paid_hours',
  'Job Description': 'job_description',
  'Hourly Rate': 'hourly_rate',
  'Staff Hourly/Monthly Rate Currency': 'staff_hourly_monthly_rate_currency',
};

// Pipeline stage labels (fetched dynamically, cached)
let stageLabels = {};

// In-memory store: last generated contract per ticket { ticketId: { docUrl, docId, title, generatedAt } }
const lastContracts = {};

// In-memory store: last generated resume per application { appId: { docUrl, docId, title, generatedAt } }
const lastResumes = {};

// --- Auth ---
function generateToken(password) {
  return crypto.createHmac('sha256', COOKIE_SECRET).update(password).digest('hex');
}

function requireAuth(req, res, next) {
  const token = req.cookies?.auth_token;
  if (token && token === generateToken(APP_PASSWORD)) {
    return next();
  }
  res.redirect('/login');
}

// X-Robots-Tag header on all responses
app.use((req, res, next) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  next();
});

// Robots.txt - block all crawlers
app.get('/robots.txt', (req, res) => {
  res.type('text/plain');
  res.send('User-agent: *\nDisallow: /\n');
});

// Login page
app.get('/login', (req, res) => {
  const error = req.query.error ? '<p class="login-error">Incorrect password</p>' : '';
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex, nofollow">
  <title>Login - BW Contract Generator</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; color: #333; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .login-box { background: #fff; border-radius: 12px; padding: 40px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); width: 360px; text-align: center; }
    .login-box h1 { font-size: 20px; font-weight: 600; margin-bottom: 8px; }
    .login-box p.sub { color: #666; font-size: 14px; margin-bottom: 24px; }
    .login-box input { width: 100%; padding: 10px 14px; border: 1px solid #ddd; border-radius: 6px; font-size: 14px; margin-bottom: 16px; }
    .login-box input:focus { outline: none; border-color: #00a4bd; }
    .login-box button { width: 100%; padding: 10px; background: #00a4bd; color: #fff; border: none; border-radius: 6px; font-size: 14px; font-weight: 500; cursor: pointer; }
    .login-box button:hover { background: #008da4; }
    .login-error { color: #d32f2f; font-size: 13px; margin-bottom: 12px; }
  </style>
</head>
<body>
  <form class="login-box" method="POST" action="/login">
    <h1>BW Contract Generator</h1>
    <p class="sub">Enter password to continue</p>
    ${error}
    <input type="password" name="password" placeholder="Password" autofocus required>
    <button type="submit">Sign In</button>
  </form>
</body>
</html>`);
});

app.post('/login', (req, res) => {
  const { password } = req.body;
  if (password === APP_PASSWORD) {
    const token = generateToken(APP_PASSWORD);
    res.cookie('auth_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });
    return res.redirect('/');
  }
  res.redirect('/login?error=1');
});

app.get('/logout', (req, res) => {
  res.clearCookie('auth_token');
  res.redirect('/login');
});

// Protect all routes below
app.use(requireAuth);

// Serve static files (only after auth)
app.use(express.static(path.join(__dirname, 'public')));

// --- HubSpot API helpers ---
async function hubspotFetch(url, options = {}) {
  const resp = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${HUBSPOT_TOKEN}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`HubSpot API error ${resp.status}: ${text}`);
  }
  return resp.json();
}

async function hubspotAppsFetch(url, options = {}) {
  const resp = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${HUBSPOT_APPS_TOKEN}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`HubSpot API error ${resp.status}: ${text}`);
  }
  return resp.json();
}

function stripCodeFences(html) {
  if (!html) return html;
  // Remove markdown code fences: ```html ... ``` or ``` ... ```
  return html.replace(/^```(?:html)?\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();
}

async function fetchPipelineStages() {
  if (Object.keys(stageLabels).length > 0) return stageLabels;
  try {
    for (const pid of PIPELINE_IDS) {
      const data = await hubspotFetch(
        `https://api.hubapi.com/crm/v3/pipelines/tickets/${pid}/stages`
      );
      for (const stage of data.results) {
        stageLabels[stage.id] = stage.label;
      }
    }
  } catch (err) {
    console.error('Failed to fetch pipeline stages:', err.message);
  }
  return stageLabels;
}

// --- API Routes ---

// GET /api/tickets - list tickets from Staff Onboarding pipeline
app.get('/api/tickets', async (req, res) => {
  try {
    const after = req.query.after || undefined;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const query = req.query.q || '';

    await fetchPipelineStages();

    const body = {
      filterGroups: [{
        filters: [{
          propertyName: 'hs_pipeline',
          operator: 'IN',
          values: PIPELINE_IDS,
        }],
      }],
      properties: ['subject', 'createdate', 'hs_pipeline_stage', 'role', 'client', 'onboarding_date'],
      sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }],
      limit,
    };
    if (query) body.query = query;
    if (after) body.after = after;

    const data = await hubspotFetch(
      'https://api.hubapi.com/crm/v3/objects/tickets/search',
      { method: 'POST', body: JSON.stringify(body) }
    );

    const tickets = data.results.map(t => ({
      id: t.id,
      subject: t.properties.subject,
      createdate: t.properties.createdate,
      stage: stageLabels[t.properties.hs_pipeline_stage] || t.properties.hs_pipeline_stage,
      role: t.properties.role,
      client: t.properties.client,
      onboardingDate: t.properties.onboarding_date,
      hubspotUrl: `https://app.hubspot.com/contacts/8513837/record/0-5/${t.id}`,
    }));

    res.json({
      tickets,
      total: data.total,
      paging: data.paging,
    });
  } catch (err) {
    console.error('Error fetching tickets:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/generate-contract - generate a Google Doc from a ticket
app.post('/api/generate-contract', async (req, res) => {
  try {
    const { ticketId, templateDocId } = req.body;
    if (!ticketId) return res.status(400).json({ error: 'ticketId is required' });
    if (!templateDocId) return res.status(400).json({ error: 'templateDocId is required' });

    // 1. Fetch full ticket details from HubSpot
    const url = `https://api.hubapi.com/crm/v3/objects/tickets/${ticketId}?properties=${TICKET_PROPERTIES.join(',')}`;
    const ticket = await hubspotFetch(url);
    const props = ticket.properties;

    // 2. Build staff name and title
    const staffName = [
      props.synced__submitted_legal_first_name,
      props.synced__submitted_legal_last_name,
    ].filter(Boolean).join(' ') || props.subject?.split(',')[0] || 'Unknown';

    const copyTitle = `Independent Contractor Agreement - ${staffName}`;

    // 3. Build replacements map
    const replacements = {};
    for (const [placeholder, propName] of Object.entries(FIELD_MAP)) {
      let value = props[propName] || '';

      if (placeholder === 'Synced - Staff Address 5 Country' && !value) {
        value = props.assignment_country || '';
      }
      if ((placeholder === 'Date Contract Sent' || placeholder === 'Onboarding Date') && value) {
        value = formatDate(value);
      }
      if (placeholder === 'Job Description' && value) {
        value = stripHtml(value);
      }

      replacements[placeholder] = value;
    }

    // 4. Call Apps Script web app to copy template and apply replacements
    const scriptResp = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: APPS_SCRIPT_SECRET,
        title: copyTitle,
        templateId: templateDocId,
        replacements,
      }),
      redirect: 'follow',
    });

    const scriptText = await scriptResp.text();
    let scriptData;
    try {
      scriptData = JSON.parse(scriptText);
    } catch {
      throw new Error(`Apps Script returned invalid JSON: ${scriptText.substring(0, 200)}`);
    }

    if (scriptData.error) {
      throw new Error(`Apps Script error: ${scriptData.error}`);
    }

    const result = { docUrl: scriptData.docUrl, docId: scriptData.docId, title: scriptData.title };

    // Store as last generated contract for this ticket
    lastContracts[ticketId] = { ...result, generatedAt: new Date().toISOString() };

    res.json(result);
  } catch (err) {
    console.error('Error generating contract:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/last-contracts - get last generated contracts for given ticket IDs
app.get('/api/last-contracts', (req, res) => {
  const ids = (req.query.ids || '').split(',').filter(Boolean);
  const result = {};
  for (const id of ids) {
    if (lastContracts[id]) {
      result[id] = lastContracts[id];
    }
  }
  res.json(result);
});

// --- Applications / Resumes API Routes ---

// GET /api/applications - list applications with generate_formatted_resume = Generate
app.get('/api/applications', async (req, res) => {
  try {
    const after = req.query.after || undefined;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const query = req.query.q || '';

    const body = {
      filterGroups: [{
        filters: [
          {
            propertyName: 'generate_formatted_resume',
            operator: 'EQ',
            value: 'Generate',
          },
          {
            propertyName: 'ai_formatted_resume_code',
            operator: 'HAS_PROPERTY',
          },
        ],
      }],
      properties: [
        'candidate_name', 'client_name', 'role', 'createdate',
        'generate_formatted_resume',
      ],
      sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }],
      limit,
    };
    if (query) body.query = query;
    if (after) body.after = after;

    const data = await hubspotAppsFetch(
      `https://api.hubapi.com/crm/v3/objects/${APPLICATIONS_OBJECT_TYPE}/search`,
      { method: 'POST', body: JSON.stringify(body) }
    );

    const applications = data.results.map(a => ({
      id: a.id,
      candidateName: a.properties.candidate_name || '-',
      clientName: a.properties.client_name || '-',
      role: a.properties.role || '-',
      createdate: a.properties.createdate,
      hubspotUrl: `https://app.hubspot.com/contacts/8513837/record/${APPLICATIONS_OBJECT_TYPE}/${a.id}`,
    }));

    res.json({
      applications,
      total: data.total,
      paging: data.paging,
    });
  } catch (err) {
    console.error('Error fetching applications:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/generate-resume - generate a formatted Google Doc from application HTML
app.post('/api/generate-resume', async (req, res) => {
  try {
    const { appId } = req.body;
    if (!appId) return res.status(400).json({ error: 'appId is required' });

    // 1. Fetch application with HTML content
    const url = `https://api.hubapi.com/crm/v3/objects/${APPLICATIONS_OBJECT_TYPE}/${appId}?properties=candidate_name,client_name,role,ai_formatted_resume_code`;
    const app = await hubspotAppsFetch(url);
    const props = app.properties;

    let htmlContent = props.ai_formatted_resume_code;
    if (!htmlContent) {
      return res.status(400).json({ error: 'No AI Formatted Resume Code found for this application' });
    }

    // Strip markdown code fences if present
    htmlContent = stripCodeFences(htmlContent);

    const candidateName = props.candidate_name || 'Unknown';
    const title = `Formatted Resume - ${candidateName}`;

    // 2. Call Apps Script to convert HTML to Google Doc
    const scriptResp = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: APPS_SCRIPT_SECRET,
        action: 'htmlToDoc',
        title,
        htmlContent,
      }),
      redirect: 'follow',
    });

    const scriptText = await scriptResp.text();
    let scriptData;
    try {
      scriptData = JSON.parse(scriptText);
    } catch {
      throw new Error(`Apps Script returned invalid JSON: ${scriptText.substring(0, 200)}`);
    }

    if (scriptData.error) {
      throw new Error(`Apps Script error: ${scriptData.error}`);
    }

    const result = { docUrl: scriptData.docUrl, docId: scriptData.docId, title: scriptData.title };

    // Store as last generated resume for this application
    lastResumes[appId] = { ...result, generatedAt: new Date().toISOString() };

    res.json(result);
  } catch (err) {
    console.error('Error generating resume:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/last-resumes - get last generated resumes for given application IDs
app.get('/api/last-resumes', (req, res) => {
  const ids = (req.query.ids || '').split(',').filter(Boolean);
  const result = {};
  for (const id of ids) {
    if (lastResumes[id]) {
      result[id] = lastResumes[id];
    }
  }
  res.json(result);
});

// --- Helpers ---
function formatDate(dateStr) {
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  } catch {
    return dateStr;
  }
}

function stripHtml(html) {
  return html
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
