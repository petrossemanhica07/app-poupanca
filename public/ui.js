import {
  login, me, getGroups, createGroup, getMembers, addMember,
  createMeeting, listMeetings, closeMeeting,
  createTx, groupBalance, memberBalance,
  adminOverview, groupReport, clearToken, getToken
} from './app.js';

// UI helpers
const $ = (q, root=document) => root.querySelector(q);
const $$ = (q, root=document) => Array.from(root.querySelectorAll(q));
const money = (v, c='MZN') => new Intl.NumberFormat('pt-MZ', { style:'currency', currency:c }).format(v||0);

function toast(msg, ms=1800) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), ms);
}

// Global state
let state = {
  user: null,
  groups: [],
  currentGroup: null,
  currentMeeting: null,
  members: [],
  currency: 'MZN'
};

// Navigation
function setActive(screenId) {
  $$('.screen').forEach(s => s.classList.remove('active'));
  $('#' + screenId).classList.add('active');
  $$('.bottom-nav button').forEach(b => b.classList.remove('active'));
  $(`.bottom-nav button[data-screen="${screenId}"]`)?.classList.add('active');
}

// Auth flow
async function requireLogin() {
  const modal = $('#loginModal');
  modal.classList.remove('hidden');
  modal.style.display = 'flex';  // ativa só quando realmente precisa

  return new Promise(resolve => {
    $('#btnDoLogin').onclick = async () => {
      const email = $('#email').value.trim();
      const senha = $('#senha').value.trim();
      if (!email || !senha) { toast('Preenche email e senha'); return; }

      try {
        const user = await login(email, senha);
        state.user = user;

        modal.classList.add('hidden');
        modal.style.display = 'none';   // esconde de vez

        $('#userName').textContent = user.nome;
        if (user.role === 'admin') $('.nav-admin').classList.remove('hidden');
        else $('.nav-admin').classList.add('hidden');
        resolve(user);
      } catch {
        toast('Credenciais inválidas');
      }
    };
  });
}

// Loaders
async function loadHome() {
  if (!state.currentGroup && state.groups.length) state.currentGroup = state.groups[0];
  if (state.currentGroup) {
    const bal = await groupBalance(state.currentGroup.id);
    $('#homeSaldo').textContent = money(bal.saldo, state.currentGroup.moeda || 'MZN');
    $('#homeGrupo').textContent = state.currentGroup.nome;
  } else {
    $('#homeSaldo').textContent = money(0);
    $('#homeGrupo').textContent = '—';
  }
}

async function loadGroupsSection() {
  state.groups = await getGroups();
  const sel = $('#groupSel');
  sel.innerHTML = '';
  state.groups.forEach(g => sel.appendChild(new Option(g.nome, g.id)));
  if (state.groups[0]) {
    sel.value = state.currentGroup ? state.currentGroup.id : state.groups[0].id;
    state.currentGroup = state.groups.find(g => g.id == sel.value);
    state.currency = state.currentGroup.moeda || 'MZN';
    await onGroupChange();
  } else {
    $('#groupBalance').textContent = money(0);
    $('#meetingStatus').textContent = 'Nenhuma reunião';
    $('#memberSel').innerHTML = '';
  }
}

async function onGroupChange() {
  const gid = $('#groupSel').value;
  state.currentGroup = state.groups.find(g => g.id == gid);
  state.currency = state.currentGroup?.moeda || 'MZN';

  state.members = await getMembers(gid);
  const ms = $('#memberSel');
  ms.innerHTML = '';
  state.members.forEach(m => ms.appendChild(new Option(m.nome, m.id)));

  await refreshMeetingInfo();
  const bal = await groupBalance(gid);
  $('#groupBalance').textContent = money(bal.saldo, state.currency);
}

async function refreshMeetingInfo() {
  const gid = state.currentGroup?.id;
  if (!gid) return;
  const meetings = await listMeetings(gid);
  const open = meetings.find(m => m.aberto === 1);
  state.currentMeeting = open || null;
  $('#meetingStatus').textContent = open ? `Aberta em ${open.data}${open.local ? ' — ' + open.local : ''}` : 'Nenhuma reunião aberta';
  $('#btnOpen').disabled = !!open;
  $('#btnClose').disabled = !open;
}

// Actions
async function openMeeting() {
  const gid = state.currentGroup?.id;
  if (!gid) { toast('Escolha um grupo'); return; }
  const data = new Date().toISOString().slice(0,10);
  const local = prompt('Local da reunião?') || '';
  const { id } = await createMeeting(gid, data, local, '');
  await refreshMeetingInfo();
  toast('Reunião aberta #' + id);
}

async function closeMeetingClick() {
  if (!state.currentMeeting) { toast('Nenhuma reunião aberta'); return; }
  await closeMeeting(state.currentMeeting.id);
  await refreshMeetingInfo();
  toast('Reunião fechada');
}

async function registrar(tipo) {
  if (!state.currentMeeting) { toast('Abra uma reunião primeiro'); return; }
  const member_id = $('#memberSel').value;
  if (!member_id) { toast('Selecione um membro'); return; }
  const valorStr = prompt('Valor:') || '0';
  const valor = parseFloat(valorStr.replace(',','.')) || 0;
  let multa = 0;
  if (tipo === 'penalty') {
    multa = parseFloat((prompt('Multa:') || '0').replace(',','.')) || 0;
  }
  const notas = prompt('Notas:') || '';
  await createTx({ meeting_id: state.currentMeeting.id, member_id, tipo, valor, multa, notas });
  const bal = await groupBalance(state.currentGroup.id);
  $('#groupBalance').textContent = money(bal.saldo, state.currency);
  toast('Movimento registado');
}

async function addMemberAction() {
  const gid = state.currentGroup?.id;
  if (!gid) { toast('Escolha um grupo'); return; }
  const nome = prompt('Nome do membro:');
  if (!nome) return;
  const telefone = prompt('Telefone (opcional):') || '';
  const documento = prompt('Documento (opcional):') || '';
  await addMember(gid, { nome, telefone, documento });
  await onGroupChange();
  toast('Membro adicionado');
}

async function createGroupAction() {
  if (state.user.role !== 'admin') { toast('Apenas admin'); return; }
  const nome = prompt('Nome do grupo:');
  if (!nome) return;
  const moeda = prompt('Moeda (ex: MZN, ZAR, USD):') || 'MZN';
  await createGroup({ nome, moeda });
  await loadGroupsSection();
  toast('Grupo criado');
}

// Admin load
async function loadAdmin() {
  if (state.user.role !== 'admin') return;
  const d = await adminOverview();
  $('#kpiGrupos').textContent = d.grupos;
  $('#kpiMembros').textContent = d.membros;
  $('#kpiCaixa').textContent = money(d.caixa);
  const tbody = $('#ultimas');
  tbody.innerHTML = '';
  d.ultimas.forEach(x => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>#${x.id}</td><td>${x.grupo}</td><td>${x.membro}</td><td>${x.tipo}</td><td>${money(x.valor)}</td><td>${money(x.multa)}</td><td>${new Date(x.criado_em).toLocaleString()}</td>`;
    tbody.appendChild(tr);
  });

  // Group report select
  const sel = $('#adminGroupSel');
  const groups = await getGroups();
  sel.innerHTML = '';
  groups.forEach(g => sel.appendChild(new Option(g.nome, g.id)));
  if (groups[0]) { sel.value = groups[0].id; await onAdminGroupChange(); }
}

async function onAdminGroupChange() {
  const gid = $('#adminGroupSel').value;
  const rep = await groupReport(gid);
  $('#gSaldo').textContent = money(rep.saldo);
  const tbody = $('#ranking');
  tbody.innerHTML = '';
  rep.contribs.forEach((c, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${i+1}</td><td>${c.nome}</td><td>${money(c.total)}</td>`;
    tbody.appendChild(tr);
  });
}

// Settings
function logout() {
  clearToken();
  location.reload();
}

// Bind UI
function bindEvents() {
  $$('.bottom-nav button').forEach(btn => {
    btn.addEventListener('click', async () => {
      setActive(btn.dataset.screen);
      if (btn.dataset.screen === 'home') await loadHome();
      if (btn.dataset.screen === 'groups') await loadGroupsSection();
      if (btn.dataset.screen === 'admin') await loadAdmin();
    });
  });
  $('#groupSel').addEventListener('change', onGroupChange);
  $('#btnOpen').addEventListener('click', openMeeting);
  $('#btnClose').addEventListener('click', closeMeetingClick);
  $('#btnContrib').addEventListener('click', () => registrar('contribution'));
  $('#btnLoan').addEventListener('click', () => registrar('loan'));
  $('#btnRepay').addEventListener('click', () => registrar('repayment'));
  $('#btnPenalty').addEventListener('click', () => registrar('penalty'));
  $('#btnPayout').addEventListener('click', () => registrar('payout'));
  $('#btnAddMember').addEventListener('click', addMemberAction);
  $('#btnCreateGroup').addEventListener('click', createGroupAction);
  $('#btnLogout').addEventListener('click', logout);
  $('#adminGroupSel').addEventListener('change', onAdminGroupChange);
}

// PWA
function registerSW(){
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/service-worker.js');
  }
}

// Init
window.addEventListener('DOMContentLoaded', async () => {
  bindEvents();
  registerSW();

  if (getToken()) {
    const user = await me();
    if (user) {
      state.user = user;
      $('#userName').textContent = user.nome;
      if (user.role === 'admin') $('.nav-admin').classList.remove('hidden');
      else $('.nav-admin').classList.add('hidden');

      // 🔴 certifica-se que o modal não fica preso
      $('#loginModal').classList.add('hidden');
      $('#loginModal').style.display = 'none';
    } else {
      await requireLogin();
    }
  } else {
    await requireLogin();
  }

  state.groups = await getGroups();
  await loadHome();
  await loadGroupsSection();
  if (state.user.role === 'admin') await loadAdmin();
  setActive('home');
});
