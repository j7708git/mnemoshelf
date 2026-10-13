// 中文全文檢索三方案（同一組資料、同一組查詢）：
//   T = trigram tokenizer（原始文字；查詢 <3 字元退到 LIKE）
//   B = 二元組（CJK 取相鄰二字、英數詞保留）交給 unicode61
//   S = Intl.Segmenter('zh-Hant', word) 斷詞後交給 unicode61
const SEG = new Intl.Segmenter("zh-Hant", { granularity: "word" });

/** 二元組：CJK 連續字元取相鄰兩字；英數詞整段保留。 */
export function bigrams(text) {
  const out = [];
  const re = /[A-Za-z0-9_]+|[\u3400-\u4dbf\u4e00-\u9fff]+|[^\s]/gu;
  for (const m of text.matchAll(re)) {
    const s = m[0];
    if (/^[A-Za-z0-9_]+$/.test(s)) out.push(s.toLowerCase());
    else if (/[\u3400-\u4dbf\u4e00-\u9fff]/.test(s)) {
      const chars = [...s];
      if (chars.length === 1) out.push(chars[0]);
      else for (let i = 0; i < chars.length - 1; i += 1) out.push(chars[i] + chars[i + 1]);
    }
  }
  return out.join(" ");
}

/** Intl.Segmenter 斷詞：取 isWordLike 的詞，英數轉小寫。 */
export function segmentWords(text) {
  const out = [];
  for (const part of SEG.segment(text)) {
    if (!part.isWordLike) continue;
    const t = part.segment.trim();
    if (t) out.push(/^[A-Za-z0-9_]+$/.test(t) ? t.toLowerCase() : t);
  }
  return out.join(" ");
}

const quote = (q) => `"${q.replace(/"/g, '""')}"`;
const cleanLen = (q) => [...q.replace(/\s/g, "")].length;

/** 建立三張 FTS5 表與一張 plain 表（LIKE 備援用）。 */
export function buildFtsIndex(db, docs) {
  db.exec("create table plain(id integer primary key, body text)");
  db.exec("create virtual table ft_t using fts5(body, tokenize=trigram)");
  db.exec("create virtual table ft_b using fts5(body, tokenize=unicode61)");
  db.exec("create virtual table ft_s using fts5(body, tokenize=unicode61)");
  const insPlain = db.prepare("insert into plain(id, body) values (?, ?)");
  const insT = db.prepare("insert into ft_t(rowid, body) values (?, ?)");
  const insB = db.prepare("insert into ft_b(rowid, body) values (?, ?)");
  const insS = db.prepare("insert into ft_s(rowid, body) values (?, ?)");
  for (const doc of docs) {
    insPlain.run(doc.id, doc.body);
    insT.run(doc.id, doc.body);
    insB.run(doc.id, bigrams(doc.body));
    insS.run(doc.id, segmentWords(doc.body));
  }
}

function rankFts(db, table, matchExpr, limit) {
  const rows = db
    .prepare(`select rowid as id from ${table} where ${table} match ? order by rank limit ?`)
    .all(matchExpr, limit);
  return rows.map((r) => r.id);
}

/** trigram 短查詢的 LIKE 備援（依出現次數排序）。 */
function rankLike(db, docs, q, limit) {
  const like = `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
  const rows = db.prepare("select id from plain where body like ? escape '\\'").all(like);
  return rows
    .map((r) => {
      const body = docs[r.id].body;
      let count = 0;
      let idx = 0;
      while ((idx = body.indexOf(q, idx)) !== -1) {
        count += 1;
        idx += q.length;
      }
      return [r.id, count];
    })
    .sort((a, b) => b[1] - a[1])
    .map((x) => x[0])
    .slice(0, limit);
}

export function makeRankers(db, docs) {
  const rankT = (q, limit) => {
    if (cleanLen(q) < 3) return rankLike(db, docs, q, limit);
    try {
      return rankFts(db, "ft_t", quote(q), limit);
    } catch {
      return rankLike(db, docs, q, limit);
    }
  };
  const rankB = (q, limit) => {
    const toks = bigrams(q).split(" ").filter(Boolean);
    if (toks.length === 0) return [];
    try {
      return rankFts(db, "ft_b", toks.map(quote).join(" OR "), limit);
    } catch {
      return [];
    }
  };
  const rankS = (q, limit) => {
    const toks = segmentWords(q).split(" ").filter(Boolean);
    if (toks.length === 0) return [];
    try {
      return rankFts(db, "ft_s", toks.map(quote).join(" OR "), limit);
    } catch {
      return [];
    }
  };
  return { rankT, rankB, rankS };
}
