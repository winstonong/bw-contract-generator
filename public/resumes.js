let nextAfter = null;
let searchTimeout = null;
let currentQuery = '';

// --- Application loading ---
async function loadApplications(append = false) {
  const loading = document.getElementById('loading');
  const error = document.getElementById('error');
  const table = document.getElementById('appsTable');
  const body = document.getElementById('appsBody');
  const count = document.getElementById('appCount');
  const pagination = document.getElementById('pagination');

  if (!append) {
    loading.style.display = 'block';
    error.style.display = 'none';
    table.style.display = 'none';
    body.innerHTML = '';
    nextAfter = null;
  }

  try {
    let url = '/api/applications?limit=20';
    if (append && nextAfter) url += `&after=${nextAfter}`;
    if (currentQuery) url += `&q=${encodeURIComponent(currentQuery)}`;

    const resp = await fetch(url);
    if (!resp.ok) throw new Error(await resp.text());
    const data = await resp.json();

    // Fetch last generated resumes for these applications
    const appIds = data.applications.map(a => a.id);
    let lastResumes = {};
    if (appIds.length > 0) {
      try {
        const lrResp = await fetch(`/api/last-resumes?ids=${appIds.join(',')}`);
        if (lrResp.ok) lastResumes = await lrResp.json();
      } catch { /* ignore */ }
    }

    for (const a of data.applications) {
      const lr = lastResumes[a.id];
      const hasLastResume = !!lr;
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><a href="${a.hubspotUrl}" target="_blank">${esc(a.candidateName)}</a></td>
        <td>${esc(a.clientName)}</td>
        <td>${esc(a.role)}</td>
        <td>${formatDate(a.createdate)}</td>
        <td class="action-cell">
          <button class="btn btn-generate" onclick="generateResume('${a.id}', this)">Generate</button>
          <a id="last-${a.id}" class="btn btn-last-contract${hasLastResume ? '' : ' disabled'}"
            ${hasLastResume ? `href="${esc(lr.docUrl)}" target="_blank"` : 'href="#"'}
            ${hasLastResume ? `title="Generated: ${esc(lr.title)}"` : 'title="No resume generated yet"'}
          >Last Resume</a>
        </td>
      `;
      body.appendChild(tr);
    }

    count.textContent = `${body.children.length} of ${data.total.toLocaleString()} applications`;
    loading.style.display = 'none';
    table.style.display = 'table';

    nextAfter = data.paging?.next?.after || null;
    pagination.style.display = nextAfter ? 'block' : 'none';
  } catch (err) {
    loading.style.display = 'none';
    error.style.display = 'block';
    error.textContent = 'Failed to load applications: ' + err.message;
  }
}

function loadMore() {
  loadApplications(true);
}

function onSearch() {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    currentQuery = document.getElementById('searchInput').value.trim();
    loadApplications();
  }, 300);
}

function clearSearch() {
  document.getElementById('searchInput').value = '';
  currentQuery = '';
  loadApplications();
}

// --- Resume generation ---
async function generateResume(appId, btn) {
  const modal = document.getElementById('modal');
  const spinner = document.getElementById('modalSpinner');
  const text = document.getElementById('modalText');
  const link = document.getElementById('modalLink');
  const closeBtn = document.getElementById('modalClose');

  modal.style.display = 'flex';
  spinner.style.display = 'block';
  text.textContent = 'Generating formatted resume...';
  link.style.display = 'none';
  closeBtn.style.display = 'none';
  btn.disabled = true;

  try {
    const resp = await fetch('/api/generate-resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId }),
    });

    if (!resp.ok) {
      const err = await resp.json();
      throw new Error(err.error || 'Generation failed');
    }

    const data = await resp.json();
    spinner.style.display = 'none';
    text.textContent = `Resume created: ${data.title}`;
    link.href = data.docUrl;
    link.style.display = 'inline-block';
    closeBtn.style.display = 'inline-block';

    // Update the "Last Resume" button for this application
    const lastBtn = document.getElementById(`last-${appId}`);
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
loadApplications();
