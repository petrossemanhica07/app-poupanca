import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Caminho do banco — se não houver variável de ambiente, cria localmente
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'poupanca.db');

// Garante que a pasta existe
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
  console.log(`📂 Pasta criada: ${dbDir}`);
}

// Abre (ou cria) o banco
const db = new Database(DB_PATH);
console.log(`💾 Banco de dados aberto em: ${DB_PATH}`);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const JWT_SECRET = process.env.JWT_SECRET || 'troca-por-uma-frase-bem-longa-e-secreta';
// Inicializa DB
db.exec(`
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  hash_senha TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','group_manager','member')),
  member_id INTEGER REFERENCES members(id),
  criado_em TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  moeda TEXT NOT NULL DEFAULT 'MZN',
  regras TEXT,
  criado_em TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,
  telefone TEXT,
  documento TEXT,
  ativo INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS meetings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  data TEXT NOT NULL,
  local TEXT,
  notas TEXT,
  aberto INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL CHECK(tipo IN ('contribution','loan','repayment','penalty','payout')),
  valor REAL NOT NULL CHECK(valor >= 0),
  multa REAL NOT NULL DEFAULT 0,
  notas TEXT,
  criado_em TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS balances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL CHECK(scope IN ('system','group','member')),
  ref_id INTEGER,
  saldo REAL NOT NULL DEFAULT 0,
  atualizado_em TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(scope, ref_id)
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  acao TEXT NOT NULL,
  alvo_tabela TEXT,
  alvo_id INTEGER,
  dados TEXT,
  criado_em TEXT DEFAULT CURRENT_TIMESTAMP
);
`);

// Cria admin padrão se não existir
const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
if (userCount === 0) {
  const hash = bcrypt.hashSync('admin123', 10);
  db.prepare('INSERT INTO users (nome, email, hash_senha, role) VALUES (?,?,?,?)')
    .run('Admin', 'admin@local', hash, 'admin');
  console.log('Admin criado: admin@local / admin123');
}

// Helpers
function auth(required = true) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return required ? res.status(401).json({ error: 'Sem token' }) : next();
    try {
      req.user = jwt.verify(token, JWT_SECRET);
      next();
    } catch {
      return res.status(401).json({ error: 'Token inválido' });
    }
  };
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) return res.status(403).json({ error: 'Sem permissão' });
    next();
  };
}
function log(userId, acao, alvo_tabela, alvo_id, dados) {
  db.prepare('INSERT INTO audit_logs (user_id, acao, alvo_tabela, alvo_id, dados) VALUES (?,?,?,?,?)')
    .run(userId || null, acao, alvo_tabela || null, alvo_id || null, dados ? JSON.stringify(dados) : null);
}
function upsertBalance(scope, ref_id, delta) {
  const row = db.prepare('SELECT id FROM balances WHERE scope=? AND ref_id IS ?').get(scope, ref_id ?? null);
  if (!row) {
    db.prepare('INSERT INTO balances (scope, ref_id, saldo) VALUES (?,?,?)').run(scope, ref_id ?? null, delta);
  } else {
    db.prepare('UPDATE balances SET saldo=saldo+?, atualizado_em=CURRENT_TIMESTAMP WHERE id=?')
      .run(delta, row.id);
  }
}

// Auth
app.post('/auth/login', (req, res) => {
  const { email, senha } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (!user || !bcrypt.compareSync(senha, user.hash_senha)) return res.status(401).json({ error: 'Credenciais inválidas' });
  const token = jwt.sign({
    id: user.id,
    role: user.role,
    nome: user.nome,
    member_id: user.member_id || null
  }, JWT_SECRET, { expiresIn: '12h' });
  log(user.id, 'login', 'users', user.id, null);
  res.json({ token, user: { id: user.id, nome: user.nome, role: user.role, email: user.email, member_id: user.member_id } });
});
app.get('/me', auth(), (req, res) => res.json({ user: req.user }));

// Endpoints para membro logado
app.get('/me/balance', auth(), (req, res) => {
  if (req.user.role !== 'member') return res.status(403).json({ error: 'Apenas membros' });
  const row = db.prepare('SELECT saldo FROM balances WHERE scope="member" AND ref_id=?')
                .get(req.user.member_id);
  res.json({ saldo: row ? row.saldo : 0 });
});
app.get('/me/transactions', auth(), (req, res) => {
  if (req.user.role !== 'member') return res.status(403).json({ error: 'Apenas membros' });
  const rows = db.prepare(`
    SELECT t.tipo, t.valor, t.multa, t.notas, t.criado_em, g.nome as grupo
    FROM transactions t
    JOIN meetings mt ON mt.id = t.meeting_id
    JOIN groups g ON g.id = mt.group_id
    WHERE t.member_id = ?
    ORDER BY t.criado_em DESC
  `).all(req.user.member_id);
  res.json(rows);
});

// Groups
app.post('/groups', auth(), requireRole('admin'), (req, res) => {
  const { nome, moeda = 'MZN', regras } = req.body;
  const info = db.prepare('INSERT INTO groups (nome, moeda, regras) VALUES (?,?,?)')
    .run(nome, moeda, regras ? JSON.stringify(regras) : null);
  upsertBalance('group', info.lastInsertRowid, 0);
  log(req.user.id, 'create', 'groups', info.lastInsertRowid, { nome, moeda });
  res.status(201).json({ id: info.lastInsertRowid });
});
app.get('/groups', auth(), (req, res) => {
  const rows = db.prepare('SELECT * FROM groups ORDER BY criado_em DESC').all();
  res.json(rows);
});

// Members
app.post('/groups/:id/members', auth(), requireRole('admin','group_manager'), (req, res) => {
  const { nome, telefone, documento } = req.body;
  const info = db.prepare('INSERT INTO members (group_id, nome, telefone, documento) VALUES (?,?,?,?)')
    .run(req.params.id, nome, telefone, documento);
  upsertBalance('member', info.lastInsertRowid, 0);
  log(req.user.id, 'create', 'members', info.lastInsertRowid, { group_id: req.params.id, nome });
  res.status(201).json({ id: info.lastInsertRowid });
});
app.get('/groups/:id/members', auth(), (req, res) => {
  const rows = db.prepare('SELECT * FROM members WHERE group_id=? AND ativo=1').all(req.params.id);
  res.json(rows);
});

// Meetings
app.post('/groups/:id/meetings', auth(), requireRole('admin','group_manager'), (req, res) => {
  const { data, local, notas } = req.body;
  const info = db.prepare('INSERT INTO meetings (group_id, data, local, notas) VALUES (?,?,?,?)')
    .run(req.params.id, data, local, notas);
  log(req.user.id, 'create', 'meetings', info.lastInsertRowid, { group_id: req.params.id, data });
  res.status(201).json({ id: info.lastInsertRowid });
});

app.get('/groups/:id/meetings', auth(), (req, res) => {
  const rows = db.prepare('SELECT * FROM meetings WHERE group_id=? ORDER BY data DESC').all(req.params.id);
  res.json(rows);
});

app.patch('/meetings/:id/close', auth(), requireRole('admin','group_manager'), (req, res) => {
  db.prepare('UPDATE meetings SET aberto=0 WHERE id=?').run(req.params.id);
  log(req.user.id, 'update', 'meetings', req.params.id, { aberto: 0 });
  res.json({ ok: true });
});

// Transactions
app.post('/transactions', auth(), requireRole('admin','group_manager'), (req, res) => {
  const { meeting_id, member_id, tipo, valor, multa = 0, notas } = req.body;
  const meeting = db.prepare('SELECT * FROM meetings WHERE id=?').get(meeting_id);
  if (!meeting || !meeting.aberto) return res.status(400).json({ error: 'Reunião inválida/fechada' });

  const info = db.prepare(`
    INSERT INTO transactions (meeting_id, member_id, tipo, valor, multa, notas)
    VALUES (?,?,?,?,?,?)
  `).run(meeting_id, member_id, tipo, valor, multa, notas);

  const total = valor + (multa || 0);
  if (tipo === 'contribution' || tipo === 'penalty' || tipo === 'repayment') {
    upsertBalance('group', meeting.group_id, total);
    upsertBalance('member', member_id, -valor);
  } else if (tipo === 'loan' || tipo === 'payout') {
    upsertBalance('group', meeting.group_id, -valor);
    upsertBalance('member', member_id, valor);
  }
  upsertBalance('system', null, 0);
  log(req.user.id, 'create', 'transactions', info.lastInsertRowid, { tipo, valor, member_id });

  res.status(201).json({ id: info.lastInsertRowid });
});

app.get('/groups/:id/balance', auth(), (req, res) => {
  const row = db.prepare('SELECT saldo FROM balances WHERE scope="group" AND ref_id=?').get(req.params.id);
  res.json({ saldo: row ? row.saldo : 0 });
});

app.get('/members/:id/balance', auth(), (req, res) => {
  const row = db.prepare('SELECT saldo FROM balances WHERE scope="member" AND ref_id=?').get(req.params.id);
  res.json({ saldo: row ? row.saldo : 0 });
});

// Reports
app.get('/reports/overview', auth(), requireRole('admin'), (req, res) => {
  const grupos = db.prepare('SELECT COUNT(*) c FROM groups').get().c;
  const membros = db.prepare('SELECT COUNT(*) c FROM members WHERE ativo=1').get().c;
  const caixa = db.prepare('SELECT SUM(saldo) s FROM balances WHERE scope="group"').get().s || 0;
  const ultimas = db.prepare(`
    SELECT t.id, g.nome as grupo, m.nome as membro, t.tipo, t.valor, t.multa, t.criado_em
    FROM transactions t
    JOIN meetings mt ON mt.id=t.meeting_id
    JOIN groups g ON g.id=mt.group_id
    JOIN members m ON m.id=t.member_id
    ORDER BY t.id DESC LIMIT 10
  `).all();
  res.json({ grupos, membros, caixa, ultimas });
});

app.get('/reports/group/:id', auth(), requireRole('admin','group_manager'), (req, res) => {
  const saldo = db.prepare('SELECT saldo FROM balances WHERE scope="group" AND ref_id=?').get(req.params.id)?.saldo || 0;
  const contribs = db.prepare(`
    SELECT m.nome, SUM(CASE WHEN t.tipo='contribution' THEN t.valor ELSE 0 END) as total
    FROM transactions t
    JOIN members m ON m.id=t.member_id
    JOIN meetings mt ON mt.id=t.meeting_id
    WHERE mt.group_id=?
    GROUP BY m.id
    ORDER BY total DESC
  `).all(req.params.id);
  res.json({ saldo, contribs });
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor na porta ${PORT}`));
