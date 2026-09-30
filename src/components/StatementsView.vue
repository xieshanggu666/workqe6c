<template>
  <div class="st">
    <div class="st-toolbar">
      <button v-if="canOps" class="add" @click="openForm()">＋ 起草声明</button>
      <div class="chips">
        <button class="chip" :class="{on:!filter}" @click="setFilter('')">全部 {{ totalCount }}</button>
        <button v-for="(txt,k) in dict.status" :key="k" class="chip" :class="[k,{on:filter===k}]" @click="setFilter(k)">
          {{ txt }} {{ summary.counts?.[k]||0 }}
        </button>
      </div>
      <select v-if="canOps" v-model="team" class="team-switch" title="本次操作职能（跨角色协同：公关起草/送审 · 法务审核 · 发布人员分渠道执行）">
        <option v-for="(t,k) in dict.role" :key="k" :value="k">{{ teamIcon(k) }} {{ t }}</option>
      </select>
      <span class="me">👤 {{ store.user.name }} · {{ roleText(store.user.role) }}</span>
    </div>
    <p class="hint">📣 公关起草危机声明 → 法务审核（驳回退回修改并升版本）→ 发布人员分渠道执行并登记结果（链接/说明，失败可重发）；发布进度全程回写危机时间线与关联处置工单日志。操作需匹配职能（管理员可代办）。</p>

    <!-- 起草声明表单 -->
    <form v-if="showForm" class="st-form" @submit.prevent="create">
      <div v-if="!openCrises.length" class="no-crisis">⚠️ 暂无未结案危机事件，无法起草声明（已结案事件需先回滚结案）</div>
      <template v-else>
      <div class="row">
        <select v-model.number="form.crisis_id" required @change="loadWoOptions">
          <option :value="null" disabled>选择所属危机事件（未结案）</option>
          <option v-for="c in openCrises" :key="c.id" :value="c.id">#{{ c.id }} {{ c.title }}（{{ stText(c.status) }}）</option>
        </select>
        <select v-model.number="form.work_order_id">
          <option :value="null">不关联处置工单</option>
          <option v-for="w in woOptions" :key="w.id" :value="w.id">📋 #{{ w.id }} {{ w.title }}（{{ w.statusText }}）</option>
        </select>
      </div>
      <input v-model="form.title" placeholder="声明标题，如 关于涉事门店卫生问题的致歉与整改声明" required />
      <textarea v-model="form.content" placeholder="声明正文（法务审核口径，审核通过后按渠道发布）" required></textarea>
      <div class="chan-pick">
        <span class="cp-label">发布渠道：</span>
        <label v-for="(t,k) in dict.channel" :key="k" class="cp-item" :class="{on:form.channels.includes(k)}">
          <input type="checkbox" :value="k" v-model="form.channels" /> {{ t }}
        </label>
      </div>
      <div class="row">
        <button class="save" type="submit">起草声明（公关）</button>
        <button type="button" class="ghost" @click="showForm=false">取消</button>
      </div>
      </template>
    </form>

    <div v-if="!items.length" class="none">暂无危机声明（在危机处置页或此处由公关起草）</div>

    <!-- 声明看板 -->
    <div class="board">
      <div v-for="s in items" :key="s.id" class="st-card" :class="s.status">
        <div class="s-head">
          <span class="st-badge" :class="s.status">{{ s.statusText }}</span>
          <span class="ver">v{{ s.version }}</span>
          <b class="s-title">{{ s.title }}</b>
          <span v-if="s.wo_title" class="wo-tag" title="发布进度回写该处置工单">📋 工单 #{{ s.work_order_id }}</span>
        </div>
        <pre class="s-content">{{ s.content }}</pre>
        <div v-if="s.status==='draft' && s.review_note" class="s-reject">↩ 法务驳回：{{ s.review_note }}（修改后重新送审，当前 v{{ s.version }}）</div>
        <div v-else-if="s.review_note && s.reviewed_by" class="s-review">⚖️ 法务意见（{{ s.reviewed_by }}）：{{ s.review_note }}</div>

        <!-- 分渠道发布执行 -->
        <div class="chans">
          <span class="chans-label">渠道 {{ s.progress.done }}/{{ s.progress.total }}<em v-if="s.progress.failed"> · {{ s.progress.failed }} 失败</em></span>
          <div v-for="ch in s.channels" :key="ch.id" class="chan" :class="ch.status">
            <span class="ch-name">{{ ch.channelText }}</span>
            <span class="ch-st">{{ ch.statusText }}</span>
            <template v-if="ch.status==='published'">
              <a v-if="ch.url" class="ch-url" :href="ch.url" target="_blank" rel="noopener">🔗 链接</a>
              <span class="ch-note" :title="ch.note">{{ ch.note || '已登记' }} · {{ ch.publisher }}</span>
            </template>
            <span v-else-if="ch.status==='failed'" class="ch-note fail" :title="ch.note">⚠ {{ ch.note }}</span>
            <template v-if="canOps && ['approved','publishing'].includes(s.status) && ch.status!=='published'">
              <button class="ch-op pub" @click="publish(s, ch)">✔ 登记发布</button>
              <button v-if="ch.status==='pending'" class="ch-op fail" @click="fail(s, ch)">✕ 失败</button>
            </template>
          </div>
        </div>

        <div class="s-meta">
          <span>危机 <i>#{{ s.crisis_id }} {{ s.crisis_title || '' }}</i></span>
          <span>起草 <i>{{ s.created_by }}（公关）</i></span>
          <span v-if="s.submitted_by">送审 <i>{{ s.submitted_by }} · {{ s.submitted_at }}</i></span>
          <span v-if="s.reviewed_by">审核 <i>{{ s.reviewed_by }}（法务）· {{ s.reviewed_at }}</i></span>
          <span v-if="s.published_at">发布完成 <i>{{ s.published_at }}</i></span>
          <span>更新 <i>{{ s.updated }}</i></span>
        </div>

        <!-- 编辑表单（起草中） -->
        <form v-if="editId===s.id" class="st-edit" @submit.prevent="saveEdit(s)">
          <input v-model="editForm.title" placeholder="声明标题" required />
          <textarea v-model="editForm.content" placeholder="声明正文" required></textarea>
          <div class="chan-pick">
            <span class="cp-label">发布渠道：</span>
            <label v-for="(t,k) in dict.channel" :key="k" class="cp-item" :class="{on:editForm.channels.includes(k)}">
              <input type="checkbox" :value="k" v-model="editForm.channels" /> {{ t }}
            </label>
          </div>
          <div class="row">
            <button class="save" type="submit">保存修改</button>
            <button type="button" class="ghost" @click="editId=null">取消</button>
          </div>
        </form>

        <div class="s-actions" v-if="canOps">
          <template v-if="s.status==='draft'">
            <button class="op edit" @click="startEdit(s)">✏ 编辑</button>
            <button class="op submit" @click="submit(s)">📨 送法务审核</button>
          </template>
          <template v-if="s.status==='reviewing'">
            <button class="op approve" @click="approve(s)">✔ 法务通过</button>
            <button class="op reject" @click="reject(s)">↩ 驳回</button>
          </template>
          <button v-if="['draft','reviewing','approved'].includes(s.status)" class="op cancel" @click="cancel(s)">✕ 作废</button>
        </div>
        <button class="logbtn" @click="toggleLogs(s)">{{ logId===s.id ? '收起留痕' : '📜 留痕' }}</button>
        <div v-if="logId===s.id" class="s-logs">
          <div v-for="l in logs" :key="l.id" class="slog">
            <span class="lg-act" :class="l.action">{{ logText(l.action) }}</span>
            <span class="lg-detail">{{ l.detail }}</span>
            <em>{{ l.operator }}{{ l.operator_role ? '·'+roleName(l.operator_role) : '' }} · {{ l.time }}</em>
          </div>
          <div v-if="!logs.length" class="none">暂无留痕</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { usePubStore } from '@/store/pub'

const store = usePubStore()
const items = ref([])
const summary = ref({ counts: {} })
const dict = ref({ status: {}, channel: {}, role: {} })
const filter = ref('')
const showForm = ref(false)
const logId = ref(null)
const logs = ref([])
const editId = ref(null)
const team = ref('pr') // 本次操作职能（跨角色协同演示：pr 公关 / legal 法务 / publisher 发布人员）
const woOptions = ref([]) // 所选危机下的未完结工单（关联回写用）

const form = ref({ crisis_id: null, work_order_id: null, title: '', content: '', channels: ['weibo', 'wechat'] })
const editForm = ref({ title: '', content: '', channels: [] })

const canOps = computed(() => ['admin', 'ops'].includes(store.user.role))
const openCrises = computed(() => store.crises.filter((c) => c.status !== 'closed'))
const totalCount = computed(() => Object.values(summary.value.counts || {}).reduce((a, b) => a + b, 0))

function roleText(r) { return { admin: '管理员', ops: '值班员', viewer: '观察员' }[r] || r }
function roleName(r) { return dict.value.role[r] || r }
function teamIcon(k) { return { pr: '🖊', legal: '⚖️', publisher: '📣' }[k] || '👤' }
function stText(s) { return { monitoring: '监测中', disposal: '处置中', closed: '已结案' }[s] || s }
function logText(a) {
  return {
    draft: '起草', edit: '编辑', submit: '送审', approve: '审核通过', reject: '驳回',
    publish: '渠道发布', fail: '发布失败', done: '发布完成', cancel: '作废'
  }[a] || a
}

async function load() {
  const d = await store.fetchStatements(filter.value ? { status: filter.value } : null)
  items.value = d.items
  summary.value = d.summary
  dict.value = d.dict
}
function setFilter(k) { filter.value = k; load() }

function openForm() {
  showForm.value = true
  if (store.stmtDraftCrisis) {
    form.value.crisis_id = store.stmtDraftCrisis
    store.stmtDraftCrisis = null
    loadWoOptions()
  }
}
// 危机卡片「起草声明」跳转：预填所属危机并展开表单
watch(() => store.stmtDraftCrisis, (id) => {
  if (id) { form.value.crisis_id = id; store.stmtDraftCrisis = null; showForm.value = true; loadWoOptions() }
})
// 关联工单候选：所选危机下的未完结工单（发布进度将回写其日志）
async function loadWoOptions() {
  woOptions.value = []
  form.value.work_order_id = null
  if (!form.value.crisis_id) return
  try {
    const d = await store.fetchWorkOrders({ crisis_id: form.value.crisis_id })
    woOptions.value = d.items.filter((w) => ['todo', 'doing', 'blocked'].includes(w.status))
  } catch { /* 工单加载失败不阻塞起草 */ }
}

async function run(fn) {
  try { await fn(); await load() }
  catch (e) { store.msg(e.message, 'warn') }
}
async function create() {
  const f = form.value
  if (!f.crisis_id) { store.msg('请先选择所属危机事件', 'warn'); return }
  if (!f.channels.length) { store.msg('请至少选择一个发布渠道', 'warn'); return }
  await run(() => store.createStatement({
    crisis_id: f.crisis_id, work_order_id: f.work_order_id || null,
    title: f.title, content: f.content, channels: f.channels, team: team.value
  }))
  form.value = { crisis_id: null, work_order_id: null, title: '', content: '', channels: ['weibo', 'wechat'] }
  woOptions.value = []
  showForm.value = false
}
function startEdit(s) {
  editId.value = s.id
  editForm.value = { title: s.title, content: s.content, channels: s.channels.map((c) => c.channel) }
}
async function saveEdit(s) {
  if (!editForm.value.channels.length) { store.msg('请至少选择一个发布渠道', 'warn'); return }
  await run(async () => {
    await store.updateStatement(s.id, { ...editForm.value, team: team.value })
    store.msg('声明已保存', 'success')
  })
  editId.value = null
}
async function submit(s) {
  if (!confirm(`将声明「${s.title}」（v${s.version}）提交法务审核？`)) return
  await run(async () => {
    await store.statementOp(s.id, 'submit', { team: team.value })
    store.msg('已提交法务审核', 'success')
  })
}
async function approve(s) {
  const note = prompt(`法务审核通过声明「${s.title}」：\n审核意见（可留空）：`)
  if (note == null) return
  await run(async () => {
    await store.statementOp(s.id, 'approve', { note: note.trim(), team: team.value })
    store.msg('审核通过，已进入分渠道发布', 'success')
  })
}
async function reject(s) {
  const note = prompt(`驳回声明「${s.title}」：\n驳回原因（必填，退回公关修改并升版本）：`)
  if (note == null || !note.trim()) return
  await run(async () => {
    await store.statementOp(s.id, 'reject', { note: note.trim(), team: team.value })
    store.msg('已驳回，退回公关修改', 'info')
  })
}
async function publish(s, ch) {
  const url = prompt(`登记渠道「${ch.channelText}」发布结果：\n发布链接（可留空）：`)
  if (url == null) return
  const note = prompt('结果说明（阅读量/反馈等，可留空）：') ?? ''
  await run(async () => {
    const r = await store.statementChannelOp(s.id, ch.id, 'publish', { url: url.trim(), note: note.trim(), team: team.value })
    if (r.already) store.msg('该渠道已登记过发布，重复登记已忽略', 'info')
    else store.msg(r.statement?.status === 'published' ? '全部渠道发布完成，已回写危机时间线与工单' : `渠道「${ch.channelText}」已登记发布`, 'success')
  })
}
async function fail(s, ch) {
  const note = prompt(`标记渠道「${ch.channelText}」发布失败：\n失败原因（登记后可重新发布）：`)
  if (note == null || !note.trim()) return
  await run(async () => {
    await store.statementChannelOp(s.id, ch.id, 'fail', { note: note.trim(), team: team.value })
    store.msg(`渠道「${ch.channelText}」已标记失败，可重新发布`, 'info')
  })
}
async function cancel(s) {
  const note = prompt(`作废声明「${s.title}」？\n作废说明（可留空）：`)
  if (note == null) return
  await run(async () => {
    await store.statementOp(s.id, 'cancel', { note: note.trim(), team: team.value })
    store.msg('声明已作废', 'info')
  })
}
async function toggleLogs(s) {
  if (logId.value === s.id) { logId.value = null; logs.value = []; return }
  const d = await store.fetchStatement(s.id)
  logs.value = d.logs
  logId.value = s.id
}

let timer = null
onMounted(async () => {
  await load()
  if (store.stmtDraftCrisis) openForm()
  timer = setInterval(load, 4000)
})
onUnmounted(() => { clearInterval(timer) })
</script>

<style scoped>
.st{display:flex;flex-direction:column;gap:12px;}
.st-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.add{background:linear-gradient(135deg,#43a047,#2e7d32);border:none;color:#fff;border-radius:8px;padding:9px 14px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;}
.chips{display:flex;gap:6px;flex-wrap:wrap;align-items:center;}
.chip{background:#0f1b38;border:1px solid rgba(120,160,220,0.18);color:#8ba2c8;border-radius:14px;padding:4px 12px;font-size:11px;cursor:pointer;font-family:inherit;}
.chip.on{border-color:#2962ff;color:#fff;background:#132a52;}
.chip.draft.on{border-color:#90a4ae;background:#1c2530;}
.chip.reviewing.on{border-color:#ffb300;background:#33270e;}
.chip.approved.on,.chip.publishing.on{border-color:#42a5f5;background:#0d2137;}
.chip.published.on{border-color:#66bb6a;background:#14261a;}
.team-switch{background:#13233f;border:1px solid rgba(206,147,216,.4);color:#ce93d8;border-radius:8px;padding:6px 8px;font-size:12px;font-family:inherit;cursor:pointer;}
.me{margin-left:auto;font-size:11px;color:#8ba2c8;background:#13233f;border:1px solid rgba(120,160,220,0.2);border-radius:8px;padding:6px 12px;}
.hint{margin:0;font-size:11px;color:#5b6f94;line-height:1.5;}
.st-form,.st-edit{background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:8px;}
.no-crisis{font-size:12px;color:#ffab91;background:#3e2723;border:1px solid rgba(255,138,101,.3);border-radius:8px;padding:8px 10px;}
.row{display:flex;gap:8px;flex-wrap:wrap;}
.row select,.row input{flex:1;min-width:120px;}
input,select,textarea,button{font-family:inherit;background:#13233f;border:1px solid rgba(120,160,220,0.2);color:#dbe4f3;border-radius:8px;padding:8px 10px;font-size:12px;}
textarea{resize:vertical;min-height:72px;}
.chan-pick{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.cp-label{font-size:11px;color:#8ba2c8;}
.cp-item{display:flex;align-items:center;gap:4px;font-size:11px;color:#8ba2c8;background:#101d3a;border:1px solid rgba(120,160,220,0.18);border-radius:12px;padding:3px 10px;cursor:pointer;}
.cp-item.on{color:#90caf9;border-color:rgba(66,165,245,.5);background:#0d2137;}
.cp-item input{accent-color:#2962ff;}
.save{background:#2962ff;border:none;color:#fff;font-weight:600;cursor:pointer;}
.ghost{background:#16263f;color:#8ba2c8;cursor:pointer;}
.none{color:#5b6f94;text-align:center;padding:32px;}
.board{display:flex;flex-direction:column;gap:10px;}
.st-card{background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-left:4px solid #546e7a;border-radius:10px;padding:12px 14px;position:relative;}
.st-card.draft{border-left-color:#90a4ae;}
.st-card.reviewing{border-left-color:#ffb300;}
.st-card.approved,.st-card.publishing{border-left-color:#42a5f5;}
.st-card.published{border-left-color:#66bb6a;}
.st-card.cancelled{opacity:.5;}
.s-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-right:70px;}
.st-badge{font-size:10px;padding:2px 9px;border-radius:6px;flex:none;}
.st-badge.draft{background:#1c2530;color:#b0bec5;}
.st-badge.reviewing{background:#33270e;color:#ffe082;}
.st-badge.approved{background:#0d2137;color:#90caf9;}
.st-badge.publishing{background:#0d2137;color:#64b5f6;}
.st-badge.published{background:#1b5e20;color:#a5d6a7;}
.st-badge.cancelled{background:#21262c;color:#78909c;}
.ver{font-size:10px;color:#ce93d8;background:#241226;border-radius:5px;padding:1px 7px;flex:none;}
.s-title{color:#fff;font-size:13px;flex:1;min-width:160px;}
.wo-tag{font-size:10px;color:#80cbc4;background:#0d2620;border:1px solid rgba(128,203,196,.3);border-radius:5px;padding:1px 7px;}
.s-content{margin:8px 0 0;font-size:11px;color:#aebadd;line-height:1.6;white-space:pre-wrap;font-family:inherit;background:#0c1730;border-radius:8px;padding:8px 10px;}
.s-reject{margin-top:6px;font-size:10px;color:#ffab91;background:#3e2723;border-radius:6px;padding:4px 8px;}
.s-review{margin-top:6px;font-size:10px;color:#ce93d8;background:#241226;border-radius:6px;padding:4px 8px;}
.chans{margin-top:8px;display:flex;flex-direction:column;gap:5px;}
.chans-label{font-size:10px;color:#5b6f94;}
.chans-label em{color:#ef9a9a;font-style:normal;}
.chan{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11px;background:#0c1730;border:1px solid rgba(120,160,220,0.12);border-radius:8px;padding:5px 10px;}
.chan.published{border-color:rgba(102,187,106,.3);}
.chan.failed{border-color:rgba(239,83,80,.35);}
.ch-name{color:#90caf9;font-weight:600;flex:none;}
.ch-st{font-size:9px;padding:1px 7px;border-radius:5px;background:#16263f;color:#8ba2c8;flex:none;}
.chan.published .ch-st{background:#1b5e20;color:#a5d6a7;}
.chan.failed .ch-st{background:#4a1518;color:#ef9a9a;}
.ch-url{color:#64b5f6;font-size:10px;text-decoration:none;}
.ch-url:hover{text-decoration:underline;}
.ch-note{color:#5b6f94;font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:340px;}
.ch-note.fail{color:#ef9a9a;}
.ch-op{background:none;border:1px solid rgba(102,187,106,.4);color:#81c784;cursor:pointer;border-radius:6px;padding:2px 8px;font-size:10px;font-family:inherit;}
.ch-op.fail{border-color:rgba(239,83,80,.4);color:#ef5350;}
.s-meta{display:flex;gap:14px;flex-wrap:wrap;font-size:10px;color:#5b6f94;margin-top:8px;}
.s-meta i{color:#90caf9;font-style:normal;}
.st-edit{margin-top:8px;}
.s-actions{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;}
.op{background:none;border:1px solid rgba(144,202,249,.4);color:#90caf9;cursor:pointer;border-radius:7px;padding:4px 10px;font-size:11px;font-family:inherit;}
.op.edit{border-color:rgba(144,174,190,.5);color:#b0bec5;}
.op.submit{border-color:rgba(66,165,245,.5);color:#90caf9;}
.op.approve{border-color:rgba(102,187,106,.5);color:#81c784;}
.op.reject{border-color:rgba(255,179,0,.5);color:#ffe082;}
.op.cancel{border-color:rgba(239,83,80,.4);color:#ef5350;}
.logbtn{position:absolute;top:12px;right:12px;background:none;border:1px solid rgba(120,160,220,0.25);color:#8ba2c8;border-radius:7px;padding:3px 9px;font-size:10px;cursor:pointer;font-family:inherit;}
.s-logs{margin-top:10px;border-top:1px dashed rgba(120,160,220,0.15);padding-top:8px;display:flex;flex-direction:column;gap:5px;max-height:200px;overflow-y:auto;}
.slog{display:flex;align-items:baseline;gap:8px;font-size:10px;color:#8ba2c8;}
.slog em{margin-left:auto;color:#5b6f94;font-style:normal;white-space:nowrap;}
.lg-act{flex:none;font-size:9px;padding:1px 7px;border-radius:5px;background:#16263f;color:#90caf9;border:1px solid rgba(144,202,249,.25);}
.lg-act.reject,.lg-act.fail,.lg-act.cancel{color:#ffab91;border-color:rgba(255,138,101,.35);}
.lg-act.approve,.lg-act.done,.lg-act.publish{color:#81c784;border-color:rgba(102,187,106,.35);}
.lg-act.submit{color:#ffe082;border-color:rgba(255,213,79,.35);}
</style>
