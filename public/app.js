let nextAfter = null;
let searchTimeout = null;
let currentQuery = '';

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

    for (const t of data.tickets) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><a href="${t.hubspotUrl}" target="_blank">${esc(t.subject)}</a></td>
        <td>${esc(t.client || '-')}</td>
        <td>${esc(t.role || '-')}</td>
        <td>${t.onboardingDate ? formatDate(t.onboardingDate) : '-'}</td>
        <td><span class="stage-badge">${esc(t.stage)}</span></td>
        <td>${formatDate(t.createdate)}</td>
        <td><button class="btn btn-generate" onclick="generateContract('${t.id}', this)">Generate Contract</button></td>
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

async function generateContract(ticketId, btn) {
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
      body: JSON.stringify({ ticketId }),
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

// Load on page load
loadTickets();
