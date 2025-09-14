const API = location.origin;

function saveToken(t){ localStorage.setItem('token', t); }
function getToken(){ return localStorage.getItem('token'); }
function clearToken(){ localStorage.removeItem('token'); }
function headers(){ return { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + getToken() }; }

async function login(email, senha) {
  const r = await fetch(API + '/auth/login', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ email, senha })
  });
  if (!r.ok) throw new Error('Login falhou');
  const data = await r.json();
  saveToken(data.token);
  return data.user;
}

async function me(){
  const r = await fetch(API + '/me', { headers: headers() });
  if (!r.ok) return null;
  return r.json();
}

async function getGroups(){ const r = await fetch(API + '/groups', { headers: headers() }); return r.json(); }
async function createGroup(payload){ const r = await fetch(API + '/groups', { method:'POST', headers: headers(), body: JSON.stringify(payload) }); return r.json(); }
async function getMembers(groupId){ const r = await fetch(`${API}/groups/${groupId}/members`, { headers: headers() }); return r.json(); }
async function addMember(groupId, payload){ const r = await fetch(`${API}/groups/${groupId}/members`, { method:'POST', headers: headers(), body: JSON.stringify(payload) }); return r.json(); }
async function createMeeting(groupId, data, local, notas){
  const r = await fetch(`${API}/groups/${groupId}/meetings`, { method:'POST', headers: headers(), body: JSON.stringify({ data, local, notas }) });
  return r.json();
}
async function listMeetings(groupId){ const r = await fetch(`${API}/groups/${groupId}/meetings`, { headers: headers() }); return r.json(); }
async function closeMeeting(id){ const r = await fetch(`${API}/meetings/${id}/close`, { method:'PATCH', headers: headers() }); return r.json(); }
async function createTx(payload){
  const r = await fetch(`${API}/transactions`, { method:'POST', headers: headers(), body: JSON.stringify(payload) });
  if (!r.ok) throw new Error('Erro ao registrar transação');
  return r.json();
}
async function groupBalance(id){ const r = await fetch(`${API}/groups/${id}/balance`, { headers: headers() }); return r.json(); }
async function memberBalance(id){ const r = await fetch(`${API}/members/${id}/balance`, { headers: headers() }); return r.json(); }
async function adminOverview(){ const r = await fetch(`${API}/reports/overview`, { headers: headers() }); return r.json(); }
async function groupReport(id){ const r = await fetch(`${API}/reports/group/${id}`, { headers: headers() }); return r.json(); }

export {
  login, me, getGroups, createGroup, getMembers, addMember,
  createMeeting, listMeetings, closeMeeting,
  createTx, groupBalance, memberBalance,
  adminOverview, groupReport, clearToken
};