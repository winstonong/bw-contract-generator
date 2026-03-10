let nextAfter = null;
let searchTimeout = null;
let currentQuery = '';

// Contract template types
const CONTRACT_TYPES = [
  { key: 'outsource-hourly',       label: 'Outsource - Hourly' },
  { key: 'outsource-hourly-sc',    label: 'Outsource - Hourly with Schedule C' },
  { key: 'outsource-monthly',      label: 'Outsource - Monthly' },
  { key: 'outsource-monthly-sc',   label: 'Outsource - Monthly with Schedule C' },
  { key: 'bw-internal-hourly',     label: 'BW Internal - Hourly' },
  { key: 'bw-internal-hourly-sc',  label: 'BW Internal - Hourly with Schedule C' },
  { key: 'bw-internal-monthly',    label: 'BW Internal - Monthly' },
  { key: 'bw-internal-monthly-sc', label: 'BW Internal - Monthly with Schedule C' },
];

// --- Template storage (localStorage) ---
function getTemplates() {
  try {
    return JSON.parse(localStorage.getItem('bw_templates') || '{}');
  } catch { return {}; }
}

function saveTemplate(key, url) {
  const templates = getTemplates();
  templates[key] = url;
  localStorage.setItem('bw_templates', JSON.stringify(templates));
}

function extractDocId(url) {
  if (!url) return null;
  // Match /d/DOCID from Google Docs URL
  const m = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

function getTemplateDocId(key) {
  const templates = getTemplates();
  return extractDocId(templates[key] || '');
}

// Build the contract type <select> options HTML
function contractTypeOptions() {
  const templates = getTemplates();
  let html = '<option value="">-- Select --</option>';
  for (const ct of CONTRACT_TYPES) {
    const configured = extractDocId(templates[ct.key] || '') ? '' : ' (not set)';
    html += `<option value="${ct.key}">${esc(ct.label)}${configured}</option>`;
  }
  return html;
}

// --- Ticket loading ---
async function loadTickets(append = false) {
  const loading = document.getElementById('loading');
  const error = document.getElementById('error');
  const table = document.getElementById('ticketsTable');
  const body = document.getElementById('ticketsBody');
  const count = document.getElementById('ticketCount');
  const pagination = document.getElementById('pagination');

  if (!append) {
    loading.style.display = 'block';
    error.style.display = 'none';
    table.style.display = 'none';
    body.innerHTML = '';
    nextAfter = null;
  }

  try {
    let url = '/api/tickets?limit=20';
    if (append && nextAfter) url += `&after=${nextAfter}`;
    if (currentQuery) url += `&q=${encodeURIComponent(currentQuery)}`;

    const resp = await fetch(url);
    if (!resp.ok) throw new Error(await resp.text());
    const data = await resp.json();

    const selectHtml = contractTypeOptions();

    // Collect ticket IDs to check for last contracts
    const ticketIds = data.tickets.map(t => t.id);

    // Fetch last generated contracts for these tickets
    let lastContracts = {};
    if (ticketIds.length > 0) {
      try {
        const lcResp = await fetch(`/api/last-contracts?ids=${ticketIds.join(',')}`);
        if (lcResp.ok) lastContracts = await lcResp.json();
      } catch { /* ignore */ }
    }

    for (const t of data.tickets) {
      const lc = lastContracts[t.id];
      const hasLastContract = !!lc;
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><a href="${t.hubspotUrl}" target="_blank">${esc(t.subject)}</a></td>
        <td>${esc(t.client || '-')}</td>
        <td>${esc(t.role || '-')}</td>
        <td>${t.onboardingDate ? formatDate(t.onboardingDate) : '-'}</td>
        <td><span class="stage-badge">${esc(t.stage)}</span></td>
        <td>${formatDate(t.createdate)}</td>
        <td><select class="contract-select" id="ct-${t.id}">${selectHtml}</select></td>
        <td class="action-cell">
          <button class="btn btn-generate" onclick="generateContract('${t.id}', this)">Generate</button>
          <a id="last-${t.id}" class="btn btn-last-contract${hasLastContract ? '' : ' disabled'}"
            ${hasLastContract ? `href="${esc(lc.docUrl)}" target="_blank"` : 'href="#"'}
            ${hasLastContract ? `title="Generated: ${esc(lc.title)}"` : 'title="No contract generated yet"'}
          >Last Contract</a>
        </td>
      `;
      body.appendChild(tr);
    }

    count.textContent = `${body.children.length} of ${data.total.toLocaleString()} tickets`;
    loading.style.display = 'none';
    table.style.display = 'table';

    nextAfter = data.paging?.next?.after || null;
    pagination.style.display = nextAfter ? 'block' : 'none';
  } catch (err) {
    loading.style.display = 'none';
    error.style.display = 'block';
    error.textContent = 'Failed to load tickets: ' + err.message;
  }
}

function loadMore() {
  loadTickets(true);
}

function onSearch() {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    currentQuery = document.getElementById('searchInput').value.trim();
    loadTickets();
  }, 300);
}

function clearSearch() {
  document.getElementById('searchInput').value = '';
  currentQuery = '';
  loadTickets();
}

// --- Contract generation ---
async function generateContract(ticketId, btn) {
  // Get selected contract type
  const select = document.getElementById(`ct-${ticketId}`);
  const contractKey = select ? select.value : '';

  if (!contractKey) {
    alert('Please select a contract type before generating.');
    return;
  }

  const templateDocId = getTemplateDocId(contractKey);
  if (!templateDocId) {
    alert('No template URL configured for this contract type. Set it in Template Configuration below.');
    return;
  }

  const modal = document.getElementById('modal');
  const spinner = document.getElementById('modalSpinner');
  const text = document.getElementById('modalText');
  const link = document.getElementById('modalLink');
  const closeBtn = document.getElementById('modalClose');

  modal.style.display = 'flex';
  spinner.style.display = 'block';
  text.textContent = 'Generating contract...';
  link.style.display = 'none';
  closeBtn.style.display = 'none';
  btn.disabled = true;

  try {
    const resp = await fetch('/api/generate-contract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticketId, templateDocId }),
    });

    if (!resp.ok) {
      const err = await resp.json();
      throw new Error(err.error || 'Generation failed');
    }

    const data = await resp.json();
    spinner.style.display = 'none';
    text.textContent = `Contract created: ${data.title}`;
    link.href = data.docUrl;
    link.style.display = 'inline-block';
    closeBtn.style.display = 'inline-block';

    // Update the "Last Contract" button for this ticket
    const lastBtn = document.getElementById(`last-${ticketId}`);
    if (lastBtn) {
      lastBtn.href = data.docUrl;
      lastBtn.target = '_blank';
      lastBtn.title = `Generated: ${data.title}`;
      lastBtn.classList.remove('disabled');
    }
  } catch (err) {
    spinner.style.display = 'none';
    text.textContent = 'Error: ' + err.message;
    closeBtn.style.display = 'inline-block';
  } finally {
    btn.disabled = false;
  }
}

function closeModal() {
  document.getElementById('modal').style.display = 'none';
}

// --- Admin: Template Configuration ---
function initAdmin() {
  const grid = document.getElementById('templateGrid');
  if (!grid) return;
  const templates = getTemplates();

  grid.innerHTML = CONTRACT_TYPES.map(ct => `
    <div class="template-row">
      <label class="template-label">${esc(ct.label)}</label>
      <input type="text" class="template-input" id="tmpl-${ct.key}"
        placeholder="https://docs.google.com/document/d/..."
        value="${esc(templates[ct.key] || '')}"
        oninput="onTemplateChange('${ct.key}', this.value)">
      <span class="template-status" id="status-${ct.key}">${templates[ct.key] && extractDocId(templates[ct.key]) ? '&#10003;' : ''}</span>
    </div>
  `).join('');
}

function onTemplateChange(key, url) {
  saveTemplate(key, url);
  const status = document.getElementById(`status-${key}`);
  if (status) {
    status.innerHTML = extractDocId(url) ? '&#10003;' : '';
  }
}

function toggleAdmin() {
  const body = document.getElementById('adminBody');
  const toggle = document.getElementById('adminToggle');
  if (body.style.display === 'none') {
    body.style.display = 'block';
    toggle.innerHTML = '&#9660;';
  } else {
    body.style.display = 'none';
    toggle.innerHTML = '&#9654;';
  }
}

// --- Helpers ---
function formatDate(str) {
  if (!str) return '-';
  try {
    const d = new Date(str);
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return str;
  }
}

function esc(s) {
  if (!s) return '';
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// --- Init ---
initAdmin();
loadTickets();
