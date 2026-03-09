const express = require('express');
const { google } = require('googleapis');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

const HUBSPOT_TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;
const TEMPLATE_DOC_ID = process.env.GOOGLE_TEMPLATE_DOC_ID || '14DuY9yEFYT7ea-Oz-wW4zyK9zP25Am6YkwDVXJ6VRZM';
const DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID || '';

// Staff Onboarding (Outsource) pipeline
const PIPELINE_ID = '4483329';

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
  'contract_sending_date', 'hourly_rate', 'currency',
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
};

// Pipeline stage labels (fetched dynamically, cached)
let stageLabels = {};

// --- Google Auth ---
function getGoogleAuth() {
  const keyJson = JSON.parse(
    Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_KEY, 'base64').toString('utf-8')
  );
  return new google.auth.GoogleAuth({
    credentials: keyJson,
    scopes: [
      'https://www.googleapis.com/auth/documents',
      'https://www.googleapis.com/auth/drive',
    ],
  });
}

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

async function fetchPipelineStages() {
  if (Object.keys(stageLabels).length > 0) return stageLabels;
  try {
    const data = await hubspotFetch(
      `https://api.hubapi.com/crm/v3/pipelines/tickets/${PIPELINE_ID}/stages`
    );
    for (const stage of data.results) {
      stageLabels[stage.id] = stage.label;
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

    await fetchPipelineStages();

    const body = {
      filterGroups: [{
        filters: [{
          propertyName: 'hs_pipeline',
          operator: 'EQ',
          value: PIPELINE_ID,
        }],
      }],
      properties: ['subject', 'createdate', 'hs_pipeline_stage', 'role', 'client', 'onboarding_date'],
      sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }],
      limit,
    };
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
    const { ticketId } = req.body;
    if (!ticketId) return res.status(400).json({ error: 'ticketId is required' });

    // 1. Fetch full ticket details from HubSpot
    const url = `https://api.hubapi.com/crm/v3/objects/tickets/${ticketId}?properties=${TICKET_PROPERTIES.join(',')}`;
    const ticket = await hubspotFetch(url);
    const props = ticket.properties;

    // 2. Copy the Google Doc template
    const auth = getGoogleAuth();
    const drive = google.drive({ version: 'v3', auth });
    const docs = google.docs({ version: 'v1', auth });

    const staffName = [
      props.synced__submitted_legal_first_name,
      props.synced__submitted_legal_last_name,
    ].filter(Boolean).join(' ') || props.subject?.split(',')[0] || 'Unknown';

    const copyTitle = `Independent Contractor Agreement - ${staffName}`;

    const copyParams = { name: copyTitle };
    if (DRIVE_FOLDER_ID) copyParams.parents = [DRIVE_FOLDER_ID];

    const copy = await drive.files.copy({
      fileId: TEMPLATE_DOC_ID,
      requestBody: copyParams,
    });
    const newDocId = copy.data.id;

    // 3. Build replacements
    const requests = [];
    for (const [placeholder, propName] of Object.entries(FIELD_MAP)) {
      let value = props[propName] || '';

      // Fallback: if country is empty, try assignment_country
      if (placeholder === 'Synced - Staff Address 5 Country' && !value) {
        value = props.assignment_country || '';
      }

      // Format dates nicely
      if (placeholder === 'Date Contract Sent' && value) {
        value = formatDate(value);
      }
      if (placeholder === 'Onboarding Date' && value) {
        value = formatDate(value);
      }

      // Strip HTML from job description
      if (placeholder === 'Job Description' && value) {
        value = stripHtml(value);
      }

      requests.push({
        replaceAllText: {
          containsText: { text: `[${placeholder}]`, matchCase: false },
          replaceText: value,
        },
      });
    }

    // 4. Execute replacements
    if (requests.length > 0) {
      await docs.documents.batchUpdate({
        documentId: newDocId,
        requestBody: { requests },
      });
    }

    // 5. Make the doc accessible to anyone with the link
    await drive.permissions.create({
      fileId: newDocId,
      requestBody: { role: 'writer', type: 'anyone' },
    });

    const docUrl = `https://docs.google.com/document/d/${newDocId}/edit`;

    res.json({ docUrl, docId: newDocId, title: copyTitle });
  } catch (err) {
    console.error('Error generating contract:', err);
    res.status(500).json({ error: err.message });
  }
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
