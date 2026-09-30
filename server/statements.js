import { db } from './db.js'
import { now, addTimeline } from './pipeline.js'
import { noteWorkOrderProgress } from './workorders.js'

const q = (sql, ...p) => db.prepare(sql).all(...p)
const q1 = (sql, ...p) => db.prepare(sql).get(...p)
const run = (sql, ...p) => db.prepare(sql).run(...p)

// ===== 常量与口径 =====
export const ST_STATUS = {
  draft: '起草中', reviewing: '法务审核中', approved: '待发布',
  publishing: '发布中', published: '已发布', cancelled: '已作废'
}
export const ST_CHANNEL = { weibo: '微博', wechat: '微信', official: '官网', news: '新闻媒体', douyin: '抖音', app: 'APP推送' }
export const CH_STATUS = { pending: '待发布', published: '已发布', failed: '发布失败' }
// 职能团队（跨角色协同）：公关起草/送审、法务审核、发布人员分渠道执行
export const ST_ROLE = { pr: '公关', legal: '法务', publisher: '发布人员' }
// 进行中状态（看板角标/危机卡片统计口径）
const ACTIVE = ['draft', 'reviewing', 'approved', 'publishing']

// 职能守卫：动作须由对应职能团队执行（请求体携带 team）；平台管理员（协调组）可代办任意职能
function teamOf(actor, body, need) {
  const t = String(body?.team || '').trim()
  if (actor.role === 'admin') return ST_ROLE[t] ? t : need
  return t === need ? t : null
}
const teamErr = (need) => ({ error: `该操作需${ST_ROLE[need]}职能执行（请在页面右上角切换操作职能；管理员可代办）`, status: 403 })

function addLog(sid, action, detail, actor, team) {
  run('INSERT INTO statement_logs (statement_id,action,detail,operator,operator_role,time) VALUES (?,?,?,?,?,?)',
    sid, action, detail || '', actor.user || '系统', team || '', now())
}

// 发布进度回写：危机统一时间线（已结案事件不回写，保证结案档案稳定）+ 关联处置工单日志
function writeback(st, action, note, ts) {
  const c = q1('SELECT status FROM crisis WHERE id=?', st.crisis_id)
  if (c && c.status !== 'closed') addTimeline(st.crisis_id, action, note, ts)
  return c
}
function woNote(st, text, actor, team) {
  if (st.work_order_id) noteWorkOrderProgress(st.work_order_id, text, actor, team)
}

// ===== 查询 =====
function decorate(s) {
  const channels = q('SELECT * FROM statement_channels WHERE statement_id=? ORDER BY id', s.id)
    .map((c) => ({ ...c, channelText: ST_CHANNEL[c.channel] || c.channel, statusText: CH_STATUS[c.status] || c.status }))
  const done = channels.filter((c) => c.status === 'published').length
  const failed = channels.filter((c) => c.status === 'failed').length
  return {
    ...s,
    statusText: ST_STATUS[s.status] || s.status,
    channels,
    progress: { total: channels.length, done, failed }
  }
}

export function listStatements({ status = '', crisisId = null, limit = 200 } = {}) {
  let sql = `SELECT s.*, c.title crisis_title, c.status crisis_status, c.level crisis_level, w.title wo_title
    FROM statements s
    LEFT JOIN crisis c ON c.id=s.crisis_id
    LEFT JOIN work_orders w ON w.id=s.work_order_id
    WHERE 1=1`
  const args = []
  if (status) { sql += ' AND s.status=?'; args.push(status) }
  if (crisisId) { sql += ' AND s.crisis_id=?'; args.push(crisisId) }
  sql += ' ORDER BY s.id DESC LIMIT ?'
  args.push(limit)
  return q(sql, ...args).map(decorate)
}

export function getStatement(id) {
  const s = q1(`SELECT s.*, c.title crisis_title, c.status crisis_status, c.level crisis_level, w.title wo_title
    FROM statements s
    LEFT JOIN crisis c ON c.id=s.crisis_id
    LEFT JOIN work_orders w ON w.id=s.work_order_id
    WHERE s.id=?`, id)
  return s ? decorate(s) : null
}

export function statementLogs(id) {
  return q('SELECT * FROM statement_logs WHERE statement_id=? ORDER BY id ASC', id)
}

// 看板汇总（页签角标/看板头部）
export function statementSummary() {
  const rows = q('SELECT status, COUNT(*) c FROM statements GROUP BY status')
  const counts = { draft: 0, reviewing: 0, approved: 0, publishing: 0, published: 0, cancelled: 0 }
  for (const r of rows) counts[r.status] = r.c
  return { counts, active: ACTIVE.reduce((a, k) => a + counts[k], 0) }
}

// 渠道清单归一化：过滤非法渠道、去重、按固定顺序
function normalizeChannels(list) {
  const set = new Set(Array.isArray(list) ? list : [])
  return Object.keys(ST_CHANNEL).filter((k) => set.has(k))
}
const chanTextOf = (sid) =>
  q('SELECT channel FROM statement_channels WHERE statement_id=? ORDER BY id', sid)
    .map((r) => ST_CHANNEL[r.channel] || r.channel).join('、')

// ===== 起草（公关） =====
export function createStatement(body, actor) {
  const team = teamOf(actor, body, 'pr')
  if (!team) return teamErr('pr')
  const b = body || {}
  const title = String(b.title || '').trim()
  if (!title) return { error: '声明标题必填' }
  const content = String(b.content || '').trim()
  if (!content) return { error: '声明正文必填' }
  const crisisId = +b.crisis_id
  const c = q1('SELECT * FROM crisis WHERE id=?', crisisId)
  if (!c) return { error: '所属危机事件不存在' }
  if (c.status === 'closed') return { error: '事件已结案，不能再起草声明（如需发布请先回滚结案）' }
  const channels = normalizeChannels(b.channels)
  if (!channels.length) return { error: '请至少选择一个发布渠道' }
  // 关联处置工单：须属于同一危机且未完结（发布进度将回写该工单日志）
  let woId = null
  if (b.work_order_id) {
    const w = q1('SELECT * FROM work_orders WHERE id=?', +b.work_order_id)
    if (!w) return { error: '关联工单不存在' }
    if (w.crisis_id !== crisisId) return { error: '关联工单须属于同一危机事件' }
    if (['done', 'cancelled'].includes(w.status)) return { error: '关联工单已完结，请选择未完结工单' }
    woId = w.id
  }
  const ts = now()
  const r = run(`INSERT INTO statements (crisis_id,work_order_id,title,content,status,version,created_by,created,updated)
    VALUES (?,?,?,?,'draft',1,?,?,?)`, crisisId, woId, title, content, actor.user, ts, ts)
  const id = Number(r.lastInsertRowid)
  for (const ch of channels) run('INSERT INTO statement_channels (statement_id,channel,status,updated) VALUES (?,?,?,?)', id, ch, 'pending', ts)
  const chanText = channels.map((x) => ST_CHANNEL[x]).join('、')
  addLog(id, 'draft', `公关起草声明 v1（计划渠道：${chanText}）`, actor, team)
  writeback({ crisis_id: crisisId }, '声明起草', `公关 ${actor.user} 起草危机声明「${title}」（计划渠道：${chanText}）`, ts)
  woNote({ work_order_id: woId }, `声明「${title}」已起草（v1，计划渠道：${chanText}）`, actor, team)
  return { ok: true, id }
}

// ===== 编辑（公关，仅起草中；渠道计划随稿重建） =====
export function updateStatement(id, body, actor) {
  const s = q1('SELECT * FROM statements WHERE id=?', id)
  if (!s) return null
  const team = teamOf(actor, body, 'pr')
  if (!team) return teamErr('pr')
  if (s.status !== 'draft') return { error: `当前状态（${ST_STATUS[s.status]}）不能编辑，仅起草中的声明可修改` }
  const title = String(body?.title || '').trim() || s.title
  const content = String(body?.content || '').trim() || s.content
  const channels = normalizeChannels(body?.channels)
  const ts = now()
  db.exec('BEGIN')
  try {
    run('UPDATE statements SET title=?, content=?, updated=? WHERE id=? AND status=?', title, content, ts, id, 'draft')
    if (channels.length) {
      run('DELETE FROM statement_channels WHERE statement_id=?', id) // 起草中渠道均为待发布，可整体重建
      for (const ch of channels) run('INSERT INTO statement_channels (statement_id,channel,status,updated) VALUES (?,?,?,?)', id, ch, 'pending', ts)
    }
    addLog(id, 'edit', `编辑声明 v${s.version}：更新${channels.length ? '标题/正文/渠道计划' : '标题/正文'}`, actor, team)
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
    throw e
  }
  return { ok: true, statement: getStatement(id) }
}

// ===== 送审（公关：draft → reviewing） =====
export function submitStatement(id, body, actor) {
  const s = q1('SELECT * FROM statements WHERE id=?', id)
  if (!s) return null
  const team = teamOf(actor, body, 'pr')
  if (!team) return teamErr('pr')
  if (s.status !== 'draft') return { error: `当前状态（${ST_STATUS[s.status]}）不能送审` }
  const ts = now()
  const r = run("UPDATE statements SET status='reviewing', submitted_by=?, submitted_at=?, updated=? WHERE id=? AND status='draft'",
    actor.user, ts, ts, id)
  if (!Number(r.changes)) return { error: '声明状态已变化，请刷新' }
  addLog(id, 'submit', `提交法务审核（v${s.version}）`, actor, team)
  writeback(s, '声明送审', `声明「${s.title}」已提交法务审核（v${s.version}）`, ts)
  woNote(s, `声明「${s.title}」已提交法务审核（v${s.version}）`, actor, team)
  return { ok: true, statement: getStatement(id) }
}

// ===== 法务审核（reviewing → approved / 驳回退回 draft 并升版本） =====
export function reviewStatement(id, body, actor, pass) {
  const s = q1('SELECT * FROM statements WHERE id=?', id)
  if (!s) return null
  const team = teamOf(actor, body, 'legal')
  if (!team) return teamErr('legal')
  if (s.status !== 'reviewing') return { error: `当前状态（${ST_STATUS[s.status]}）不在法务审核中` }
  const note = String(body?.note || '').trim()
  if (!pass && !note) return { error: '驳回必须填写驳回原因（退回公关修改）' }
  const ts = now()
  if (pass) {
    const r = run("UPDATE statements SET status='approved', reviewed_by=?, reviewed_at=?, review_note=?, updated=? WHERE id=? AND status='reviewing'",
      actor.user, ts, note, ts, id)
    if (!Number(r.changes)) return { error: '声明状态已变化，请刷新' }
    const chanText = chanTextOf(id)
    addLog(id, 'approve', `法务审核通过${note ? `：${note}` : ''}`, actor, team)
    writeback(s, '声明审核通过', `法务 ${actor.user} 审核通过声明「${s.title}」，进入分渠道发布（${chanText}）`, ts)
    woNote(s, `法务审核通过，进入分渠道发布（${chanText}）`, actor, team)
  } else {
    // 驳回：退回起草中，版本 +1（公关修改后重新送审）
    const r = run("UPDATE statements SET status='draft', version=version+1, reviewed_by=?, reviewed_at=?, review_note=?, updated=? WHERE id=? AND status='reviewing'",
      actor.user, ts, note, ts, id)
    if (!Number(r.changes)) return { error: '声明状态已变化，请刷新' }
    addLog(id, 'reject', `法务驳回：${note}（退回公关修改，版本升至 v${s.version + 1}）`, actor, team)
    writeback(s, '声明驳回', `法务 ${actor.user} 驳回声明「${s.title}」：${note}（退回公关修改）`, ts)
    woNote(s, `法务驳回声明「${s.title}」：${note}（退回公关修改）`, actor, team)
  }
  return { ok: true, statement: getStatement(id) }
}

// ===== 分渠道发布登记（发布人员：pending/failed → published，全部完成则声明已发布） =====
export function publishChannel(id, channelId, body, actor) {
  const s = q1('SELECT * FROM statements WHERE id=?', id)
  if (!s) return null
  const team = teamOf(actor, body, 'publisher')
  if (!team) return teamErr('publisher')
  const ch = q1('SELECT * FROM statement_channels WHERE id=? AND statement_id=?', channelId, id)
  if (!ch) return { error: '发布渠道不存在' }
  if (ch.status === 'published') return { ok: true, already: true, statement: getStatement(id) } // 幂等：重复登记忽略
  if (!['approved', 'publishing'].includes(s.status)) {
    return { error: s.status === 'reviewing' ? '声明仍在法务审核中，审核通过后才能发布' : `当前状态（${ST_STATUS[s.status]}）不能登记发布` }
  }
  const url = String(body?.url || '').trim()
  const note = String(body?.note || '').trim()
  const ts = now()
  const chanText = ST_CHANNEL[ch.channel] || ch.channel
  const retry = ch.status === 'failed'
  db.exec('BEGIN')
  try {
    const r = run("UPDATE statement_channels SET status='published', publisher=?, url=?, note=?, published_at=?, updated=? WHERE id=? AND status IN ('pending','failed')",
      actor.user, url, note, ts, ts, ch.id)
    if (!Number(r.changes)) { db.exec('ROLLBACK'); return { ok: true, already: true, statement: getStatement(id) } }
    // 首渠道发布：待发布 → 发布中
    if (s.status === 'approved') run("UPDATE statements SET status='publishing', updated=? WHERE id=? AND status='approved'", ts, id)
    addLog(id, 'publish', `渠道「${chanText}」已发布${retry ? '（失败后重新发布）' : ''}${url ? `：${url}` : ''}${note ? `（${note}）` : ''}`, actor, team)
    writeback(s, '声明渠道发布', `声明「${s.title}」已在 ${chanText} 发布（发布人 ${actor.user}）${url ? `：${url}` : ''}`, ts)
    woNote(s, `渠道「${chanText}」已发布${url ? `：${url}` : ''}${note ? `（${note}）` : ''}`, actor, team)
    // 全部渠道发布完成 → 已发布
    const left = q1("SELECT COUNT(*) c FROM statement_channels WHERE statement_id=? AND status!='published'", id).c
    if (left === 0) {
      run("UPDATE statements SET status='published', published_at=?, updated=? WHERE id=?", ts, ts, id)
      const allText = chanTextOf(id)
      const total = q1('SELECT COUNT(*) c FROM statement_channels WHERE statement_id=?', id).c
      addLog(id, 'done', `全部 ${total} 个渠道发布完成`, actor, team)
      writeback(s, '声明发布完成', `声明「${s.title}」全部 ${total} 个渠道发布完成（${allText}）`, ts)
      woNote(s, `声明全部 ${total} 个渠道发布完成（${allText}）`, actor, team)
    }
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
    throw e
  }
  return { ok: true, statement: getStatement(id) }
}

// ===== 渠道发布失败登记（发布人员：pending → failed，可重新发布） =====
export function failChannel(id, channelId, body, actor) {
  const s = q1('SELECT * FROM statements WHERE id=?', id)
  if (!s) return null
  const team = teamOf(actor, body, 'publisher')
  if (!team) return teamErr('publisher')
  if (!['approved', 'publishing'].includes(s.status)) return { error: `当前状态（${ST_STATUS[s.status]}）不能标记发布失败` }
  const ch = q1('SELECT * FROM statement_channels WHERE id=? AND statement_id=?', channelId, id)
  if (!ch) return { error: '发布渠道不存在' }
  if (ch.status !== 'pending') return { error: `渠道当前状态（${CH_STATUS[ch.status]}）不能标记失败` }
  const note = String(body?.note || '').trim()
  if (!note) return { error: '请填写失败原因' }
  const ts = now()
  const chanText = ST_CHANNEL[ch.channel] || ch.channel
  const r = run("UPDATE statement_channels SET status='failed', publisher=?, note=?, updated=? WHERE id=? AND status='pending'",
    actor.user, note, ts, ch.id)
  if (!Number(r.changes)) return { error: '渠道状态已变化，请刷新' }
  // 声明进入发布中（已有失败动作说明发布执行已开始）
  if (s.status === 'approved') run("UPDATE statements SET status='publishing', updated=? WHERE id=? AND status='approved'", ts, id)
  addLog(id, 'fail', `渠道「${chanText}」发布失败：${note}`, actor, team)
  writeback(s, '声明发布受阻', `声明「${s.title}」渠道 ${chanText} 发布失败：${note}`, ts)
  woNote(s, `渠道「${chanText}」发布失败：${note}`, actor, team)
  return { ok: true, statement: getStatement(id) }
}

// ===== 作废（公关，未发布完成的声明可作废） =====
export function cancelStatement(id, body, actor) {
  const s = q1('SELECT * FROM statements WHERE id=?', id)
  if (!s) return null
  const team = teamOf(actor, body, 'pr')
  if (!team) return teamErr('pr')
  if (['published', 'cancelled'].includes(s.status)) return { error: `当前状态（${ST_STATUS[s.status]}）不能作废` }
  const note = String(body?.note || '').trim()
  const ts = now()
  const r = run("UPDATE statements SET status='cancelled', updated=? WHERE id=? AND status NOT IN ('published','cancelled')", ts, id)
  if (!Number(r.changes)) return { error: '声明状态已变化，请刷新' }
  addLog(id, 'cancel', `作废声明${note ? `：${note}` : ''}`, actor, team)
  writeback(s, '声明作废', `声明「${s.title}」已作废${note ? `：${note}` : ''}`, ts)
  woNote(s, `声明「${s.title}」已作废${note ? `：${note}` : ''}`, actor, team)
  return { ok: true, statement: getStatement(id) }
}
