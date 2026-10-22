CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  name TEXT, contact TEXT, message TEXT,
  service TEXT, service_conf REAL,
  timeframe TEXT, timeframe_conf REAL,
  budget REAL, budget_conf REAL,
  urgency TEXT, urgency_conf REAL,
  score TEXT, reply TEXT,
  response_ms INTEGER, ip_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_leads_ip ON leads(ip_hash, created_at);
CREATE TABLE IF NOT EXISTS hits (ip_hash TEXT NOT NULL, ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_hits ON hits(ip_hash, ts);
CREATE TABLE IF NOT EXISTS usage (day TEXT PRIMARY KEY, n INTEGER NOT NULL);
