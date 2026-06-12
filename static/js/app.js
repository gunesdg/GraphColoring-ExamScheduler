/**
 * Çizelgeleme Sistemi — JS v6 (OBS Mantığı)
 *
 * Pipeline:
 *   Öğrenci seçildi
 *   → registration-plan al (failed/current/upper)
 *   → Ders listesi render et (kategorilerle)
 *   → Kullanıcı seçim yapar / değiştirir
 *   → onSelectionChange()
 *     → selectedCourses güncelle
 *     → AKTS hesapla
 *     → Hoca paneli güncelle
 *     → rebuildAll() [350ms debounce]
 *       → dynamic-conflicts API (sadece selectedCourses)
 *       → drawConflictGraph(filteredNodes, filteredEdges)
 *       → rebuildBipartite(selectedCourses)
 *       → rebuildStudentGraph(selectedCourses)
 *
 * Anahtar kural: Her render fonksiyonu parametre alır.
 * Global allCourses kullanılmaz.
 */
'use strict';

// ══════════════════════════════════════════════════════
// STATE
// ══════════════════════════════════════════════════════
const S = {
  mode: 'ders',
  algorithm: 'dsatur',

  // Öğrenci
  studentId:    null,
  studentLevel: null,
  regPlan:      null,   // registration-plan yanıtı

  // Ders seçimi — SADECE bu kullanılır render'da
  selected: new Set(),  // int IDs

  // Hoca haritası — DB'den + kullanıcı ataması
  imap: {},             // {courseId: instructorId}

  // D3
  _sim: null, frozen: false, _nodes: null, _links: null,

  // Simülasyon
  simSteps: [], simIdx: 0, simTimer: null, simRunning: false,

  // Ham veri
  courses: [], students: [], instructors: [], classrooms: [],

  _rebuildTimer: null,
};

// Renk paleti (graph coloring → zaman slotu rengi)
const SLOT_COLORS = [
  '#c4a7f7','#a7d4f7','#f7a7d4','#a7f7d4','#f7d4a7',
  '#d4a7f7','#a7f7f4','#f7f4a7','#f7c4a7','#c4f7a7',
  '#a7c4f7','#f7a7c4','#d4f7a7','#f7d4c4',
];
const sc  = i => i < 0 ? '#5c5480' : SLOT_COLORS[i % SLOT_COLORS.length];
const scn = i => i < 0 ? 'Atanmadı' : `Slot ${i+1}`;

// ══════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
  const [students, courses, instructors, classrooms] = await Promise.all([
    api('/students'), api('/courses'), api('/instructors'), api('/classrooms'),
  ]);
  S.students    = students    || [];
  S.courses     = courses     || [];
  S.instructors = instructors || [];
  S.classrooms  = classrooms  || [];

  // imap'i DB'deki atamalarla başlat
  S.courses.forEach(c => {
    S.imap[c.id] = c.instructor_id || null;
  });

  renderStudentSelect();
  renderClassroomList();
  renderCourseList([], null);          // başta boş liste
  renderInstructorPanel();
  ph('conflict-graph-container',  'Öğrenci seçin ve ders kaydı yapın');
  ph('bipartite-graph-container', 'Ders seçin → bipartit graf');
  ph('student-graph-container',   'Öğrenci seçin → öğrenci grafı');
  bindEvents();
});

async function api(path, opts = {}) {
  try {
    const r = await fetch('/api' + path, { headers: {'Content-Type':'application/json'}, ...opts });
    return await r.json();
  } catch(e) { console.error('[API]', path, e); return null; }
}

// ══════════════════════════════════════════════════════
// EVENTS
// ══════════════════════════════════════════════════════
function bindEvents() {
  // Mode
  const tog = document.getElementById('mode-toggle');
  tog.addEventListener('change', () => {
    S.mode = tog.checked ? 'sinav' : 'ders';
    document.getElementById('lbl-ders').classList.toggle('active', !tog.checked);
    document.getElementById('lbl-sinav').classList.toggle('active', tog.checked);
    scheduleRebuild();
  });

  document.getElementById('algo-select').addEventListener('change', e => {
    S.algorithm = e.target.value; scheduleRebuild();
  });

  document.getElementById('btn-generate').addEventListener('click', doGenerateSchedule);

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c=>c.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-'+btn.dataset.tab).classList.add('active');
      if (btn.dataset.tab === 'bipartite') doRebuildBipartite();
      if (btn.dataset.tab === 'student')   doRebuildStudentGraph();
    });
  });

  // Öğrenci seç → OBS planı al
  document.getElementById('student-select').addEventListener('change', async e => {
    const sid = e.target.value ? parseInt(e.target.value) : null;
    S.studentId = sid;
    S.studentLevel = S.students.find(x=>x.id===sid)?.class_level ?? null;
    if (sid) await loadRegistrationPlan(sid);
    else {
      S.regPlan = null; S.selected.clear();
      renderCourseList([], null);
      renderInstructorPanel();
      clearAllGraphs();
    }
  });

  document.getElementById('btn-select-all')?.addEventListener('click', () => {
    document.querySelectorAll('.course-item:not(.locked)').forEach(item => {
      const cid = parseInt(item.dataset.courseId);
      const cb  = item.querySelector('input');
      if (cb && !cb.disabled) { cb.checked=true; S.selected.add(cid); item.classList.add('selected'); }
    });
    onSelectionChange();
  });

  document.getElementById('btn-clear-courses')?.addEventListener('click', () => {
    S.selected.clear();
    document.querySelectorAll('.course-item').forEach(item => {
      const cb = item.querySelector('input'); if(cb) cb.checked=false;
      item.classList.remove('selected');
    });
    onSelectionChange();
  });

  document.getElementById('btn-reset-instructors')?.addEventListener('click', resetInstructors);
  document.getElementById('btn-sim-start').addEventListener('click', toggleSim);
  document.getElementById('btn-sim-step').addEventListener('click', simStep);
  document.getElementById('btn-sim-reset').addEventListener('click', resetSim);
  document.getElementById('btn-freeze').addEventListener('click', toggleFreeze);
  document.getElementById('btn-soft-reset').addEventListener('click', softReset);
  document.getElementById('btn-hard-reset').addEventListener('click', hardReset);
}

// ══════════════════════════════════════════════════════
// OBS DERS KAYIT PLANI (Madde 1-5)
// ══════════════════════════════════════════════════════
async function loadRegistrationPlan(sid) {
  const plan = await api(`/students/${sid}/registration-plan`);
  if (!plan) return;
  S.regPlan = plan;

  // KURAL 4: Sadece failed + current_new otomatik seçilir
  // current_elective + upper_available → kullanıcı seçer, otomatik seçilmez
  S.selected.clear();
  plan.all_courses.forEach(c => S.selected.add(c.id));  // failed + current (zorunlu)

  // Tüm listede gösterilecek dersler:
  // - failed (kırmızı, zorunlu-seçili)
  // - current/zorunlu (mavi, zorunlu-seçili)
  // - current_elective (sarı, kullanıcı seçer — MOB301 gibi)
  // - current_skipped (gri, AKTS nedeniyle eklenemedi)
  // - upper_available (mor, kullanıcı seçecek)
  // - diğerleri (kilitli)
  const displayCourses = [
    ...plan.failed,
    ...plan.current,
    ...(plan.current_elective || []),
    ...(plan.current_skipped  || []),
    ...(plan.upper_available  || []),
  ];

  showRegistrationSummary(plan);
  renderCourseList(displayCourses, plan);
  autoCheckCourses(plan.all_courses);  // sadece failed+current işaretlenir
  renderInstructorPanel();
  updateAktsDisplay(plan.total_akts, plan.over_limit);
  scheduleRebuild();
  doRebuildStudentGraph();

  console.log('[OBS Plan]',
    '\n  failed:', plan.failed.map(c=>c.code),
    '\n  current (otomatik):', plan.current.map(c=>c.code),
    '\n  current_skipped (AKTS dolu):', (plan.current_skipped||[]).map(c=>c.code),
    '\n  upper_available (kullanıcı seçer):', (plan.upper_available||[]).map(c=>c.code),
    '\n  total_akts:', plan.total_akts,
    '\n  remaining:', plan.remaining_akts
  );
}

function showRegistrationSummary(plan) {
  const summary = document.getElementById('reg-summary');
  const alert   = document.getElementById('reg-failed-alert');
  if (!summary) return;

  const upperAvail  = plan.upper_available || [];
  const skipped     = plan.current_skipped || [];
  const remaining   = plan.remaining_akts  || 0;
  const canUpper    = plan.can_take_upper && upperAvail.length > 0;

  summary.innerHTML = `
    <div class="reg-stat-row">
      <span class="reg-stat-label">Alttan Kalan</span>
      <span class="reg-stat-val" style="color:var(--danger)">${plan.failed.length} ders — ${plan.failed.reduce((s,c)=>s+c.akts,0)} AKTS</span>
    </div>
    <div class="reg-stat-row">
      <span class="reg-stat-label">Dönem (Otomatik)</span>
      <span class="reg-stat-val" style="color:var(--sky)">${plan.current.length} ders — ${plan.current.reduce((s,c)=>s+c.akts,0)} AKTS</span>
    </div>
    ${skipped.length ? `<div class="reg-stat-row">
      <span class="reg-stat-label" style="color:var(--text-dim)">AKTS Nedeniyle Atlandı</span>
      <span class="reg-stat-val" style="color:var(--text-dim)">${skipped.map(c=>c.code).join(', ')}</span>
    </div>` : ''}
    <div class="reg-stat-row">
      <span class="reg-stat-label">Kalan AKTS</span>
      <span class="reg-stat-val" style="color:${remaining>0?'var(--mint)':'var(--text-dim)'}">${remaining} AKTS boş${canUpper?' — üstten ders seçebilirsiniz':''}</span>
    </div>
    <div class="reg-stat-row">
      <span class="reg-stat-label">Toplam AKTS</span>
      <span class="reg-stat-val" style="color:${plan.over_limit?'var(--danger)':'var(--mint)'}">${plan.total_akts}/30</span>
    </div>`;
  summary.classList.add('visible');

  if (plan.has_failed && alert) {
    const codes = plan.failed.map(c=>c.code).join(', ');
    alert.textContent = `⚠ Alttan kalan dersler alınmadan kayıt tamamlanamaz: ${codes}`;
    alert.classList.add('visible');
  } else if (alert) {
    alert.classList.remove('visible');
  }
}

// ══════════════════════════════════════════════════════
// DERS LİSTESİ RENDER (Madde 3, 4, 5 renkleri)
// ══════════════════════════════════════════════════════
function renderCourseList(planCourses, plan) {
  const list = document.getElementById('course-list');
  list.innerHTML = '';

  const planIds       = new Set(planCourses.map(c => c.id));
  const catMap        = {};
  planCourses.forEach(c => catMap[c.id] = c.category);

  // Backend'den gelen upper_available listesi — bu ID'ler AÇIK olacak
  const upperAvailIds    = new Set((plan?.upper_available    || []).map(c => c.id));
  // Seçmeli dersler (MOB301 gibi) — AÇIK, kullanıcı seçer
  const electiveIds      = new Set((plan?.current_elective   || []).map(c => c.id));
  // Tüm "seçilebilir" ID'ler
  const selectableIds    = new Set([...upperAvailIds, ...electiveIds]);
  const canTakeUpper     = !!(plan?.can_take_upper);
  const currentAkts   = [...S.selected].reduce((s, id) => {
    const c = S.courses.find(x => x.id === id); return s + (c?.akts || 0);
  }, 0);

  // Gösterilecek sıra: failed → current → current_skipped → upper_available → diğerleri(kilitli)
  const otherItems = S.courses.filter(c => !planIds.has(c.id) && !upperAvailIds.has(c.id));
  const allItems   = [...planCourses, ...otherItems];

  console.log('[renderCourseList] Debug:',
    '\n  totalAkts:', currentAkts,
    '\n  remainingAkts:', 30 - currentAkts,
    '\n  upperCoursesUnlocked:', canTakeUpper,
    '\n  upperAvailIds:', [...upperAvailIds],
    '\n  failedCoursesCompleted:', (plan?.failed||[]).length === 0 || true,
    '\n  can_take_upper:', canTakeUpper
  );

  allItems.forEach(c => {
    const category      = catMap[c.id] || null;
    const isUpperAvail  = upperAvailIds.has(c.id);
    const isElective    = electiveIds.has(c.id);
    const isSelectable  = selectableIds.has(c.id);  // upper veya seçmeli

    // ── KİLİT KURALI ──────────────────────────────────────────
    const isFirstYearBlocked = (S.studentLevel === 1 && c.class_level > 1);
    const isUpperLocked      = isUpperAvail && !canTakeUpper;
    const isOutsidePlan      = !planIds.has(c.id) && !isSelectable && !!plan;
    const isLocked           = isFirstYearBlocked || isUpperLocked || isOutsidePlan;

    // AKTS doluysa seçilebilir ama bu ders sığmıyorsa disabled
    const currentAkts2  = [...S.selected].reduce((s,id)=>{
      const x=S.courses.find(y=>y.id===id); return s+(x?.akts||0);
    }, 0);
    const aktsFullForThis = (isUpperAvail || isElective) && !isLocked &&
                            !S.selected.has(c.id) && (currentAkts2 + (c.akts||0) > 30);

    const disabledReason = isFirstYearBlocked  ? '1. sınıf öğrencileri üstten ders alamaz'
                         : isUpperLocked        ? 'Dönem dersleri tamamlanmadan üstten ders alınamaz'
                         : isOutsidePlan        ? 'Bu ders kayıt planınızda yok'
                         : aktsFullForThis      ? 'AKTS limiti doldu (30/30)'
                         : null;

    // Debug — MOB301 için özel log
    if (c.code === 'MOB301') {
      console.log('[MOB301 Debug]',
        '\n  course.code:', c.code,
        '\n  disabled:', isLocked || aktsFullForThis,
        '\n  disabledReason:', disabledReason || 'YOK',
        '\n  student.level:', S.studentLevel,
        '\n  course.class_level:', c.class_level,
        '\n  isElective:', isElective,
        '\n  isUpperAvail:', isUpperAvail,
        '\n  isFirstYearBlocked:', isFirstYearBlocked,
        '\n  isUpperLocked:', isUpperLocked,
        '\n  isOutsidePlan:', isOutsidePlan,
        '\n  totalAkts:', currentAkts2,
        '\n  prerequisiteSatisfied: N/A (no prerequisite)'
      );
    }

    const item = document.createElement('div');
    item.className = 'course-item';
    item.dataset.courseId   = c.id;
    item.dataset.classLevel = c.class_level;
    item.dataset.isUpper    = isUpperAvail ? '1' : '0';
    if (category)                        item.classList.add(`cat-${category}`);
    if (isUpperAvail && !category)       item.classList.add('cat-upper');
    if (isElective   && !category)       item.classList.add('cat-current');
    if (isLocked || aktsFullForThis)     item.classList.add('locked');
    if (disabledReason)                  item.title = disabledReason;

    const catBadge = `<span class="cat-badge ${
      category === 'failed'  ? 'failed'  :
      category === 'current' ? 'current' :
      isUpperAvail           ? 'upper'   :
      isElective             ? 'current' : ''
    }">${
      category === 'failed'  ? 'KALINDI'  :
      category === 'current' ? 'DÖNEM'    :
      isUpperAvail           ? 'ÜSTTEN'   :
      isElective             ? 'SEÇMELİ'  : ''
    }</span>`;

    const showBadge = category || isUpperAvail || isElective;

    item.innerHTML = `
      <input type="checkbox" data-course-id="${c.id}"
        ${(isLocked || aktsFullForThis) ? 'disabled' : ''}>
      <div class="course-item-info">
        <div class="course-code">
          ${c.code}
          <span class="level-badge level-${c.class_level}">${c.class_level}.Sınıf</span>
          ${showBadge ? catBadge : ''}
          ${isLocked ? '<span class="locked-badge">🔒</span>' : ''}
          ${aktsFullForThis ? '<span class="locked-badge" title="AKTS dolu">📵</span>' : ''}
        </div>
        <div class="course-name">${c.name}
          ${disabledReason && !isLocked ? `<span style="color:var(--text-dim);font-size:9px"> — ${disabledReason}</span>` : ''}
        </div>
      </div>
      <div class="course-akts">${c.akts}</div>
    `;

    item.addEventListener('click', e => {
      if (e.target.tagName === 'INPUT') return;
      if (isLocked) { lockWarn(c, isFirstYearBlocked, disabledReason); return; }
      if (aktsFullForThis) { toast('30 AKTS sınırı aşıldığı için bu ders seçilemez', 'error'); return; }
      const cb = item.querySelector('input');
      cb.checked = !cb.checked;
      toggleSelect(c.id, cb.checked, item);
    });
    item.querySelector('input').addEventListener('change', e => {
      if (isLocked) { e.target.checked = false; lockWarn(c, isFirstYearBlocked, disabledReason); return; }
      toggleSelect(c.id, e.target.checked, item);
    });

    list.appendChild(item);
  });
}

function autoCheckCourses(planCourses) {
  planCourses.forEach(c => {
    const cb   = document.querySelector(`input[data-course-id="${c.id}"]`);
    const item = document.querySelector(`.course-item[data-course-id="${c.id}"]`);
    if (cb && !cb.disabled) {
      cb.checked = true;
      item?.classList.add('selected');
    }
  });
}

function lockWarn(c, isFirstYear, reason) {
  if (isFirstYear) {
    toast(`1. sınıf öğrencileri üstten ders alamaz: ${c.code}`, 'error');
  } else if (reason) {
    toast(`${reason}: ${c.code}`, 'warning');
  } else {
    toast(`Bu ders şu an seçilemez: ${c.code}`, 'warning');
  }
}

function toggleSelect(cid, checked, item) {
  const id = parseInt(cid);
  if (checked) { S.selected.add(id); item.classList.add('selected'); }
  else         { S.selected.delete(id); item.classList.remove('selected'); }
  // Madde 5: AKTS limit kontrolü
  checkAktsLimit(id, checked, item);
  onSelectionChange();
}

function checkAktsLimit(cid, adding, item) {
  if (!adding) return;
  const totalAkts = [...S.selected].reduce((sum, id) => {
    const c = S.courses.find(x=>x.id===id);
    return sum + (c?.akts||0);
  }, 0);
  if (totalAkts > 30) {
    S.selected.delete(cid);
    const cb = document.querySelector(`input[data-course-id="${cid}"]`);
    if (cb) cb.checked = false;
    item.classList.remove('selected');
    const course = S.courses.find(x=>x.id===cid);
    // Üstten ders mi yoksa normal mi?
    const upperIds = new Set((S.regPlan?.upper_available||[]).map(c=>c.id));
    if (upperIds.has(cid)) {
      toast(`AKTS limitiniz dolduğu için bu üstten ders alınamaz: ${course?.code||''}`, 'error');
    } else {
      toast(`30 AKTS sınırı nedeniyle bu ders eklenemedi: ${course?.code||''}`, 'error');
    }
    return false;
  }
  return true;
}

// ══════════════════════════════════════════════════════
// SEÇİM DEĞİŞİNCE → MERKEZ (Madde 10)
// ══════════════════════════════════════════════════════
function onSelectionChange() {
  const ids = [...S.selected];
  const totalAkts = ids.reduce((s,id)=>{
    const c=S.courses.find(x=>x.id===id); return s+(c?.akts||0);
  }, 0);
  const remaining = 30 - totalAkts;

  updateAktsDisplay(totalAkts, totalAkts > 30);
  renderInstructorPanel();

  // Üstten derslerin disabled durumunu dinamik güncelle
  updateUpperCourseAvailability(remaining);

  scheduleRebuild();

  console.log('[onSelectionChange]',
    '\n  selectedCourseIds:', ids,
    '\n  totalAkts:', totalAkts,
    '\n  remainingAkts:', remaining,
    '\n  upperCoursesUnlocked:', !!(S.regPlan?.can_take_upper && remaining > 0)
  );
}

/**
 * AKTS değişince üstten derslerin seçilebilirliğini güncelle.
 * - Ders seçiliyse: her zaman enabled (zaten seçili)
 * - remaining >= ders.akts: enabled (seçilebilir)
 * - remaining < ders.akts: disabled (AKTS yetmez)
 */
function updateUpperCourseAvailability(remaining) {
  const upperAvailIds = new Set((S.regPlan?.upper_available   || []).map(c => c.id));
  const electiveIds   = new Set((S.regPlan?.current_elective  || []).map(c => c.id));
  const allSelectableIds = new Set([...upperAvailIds, ...electiveIds]);
  if (!allSelectableIds.size) return;

  const unlockedCodes = [], disabledCodes = [];

  allSelectableIds.forEach(cid => {
    const cb     = document.querySelector(`input[data-course-id="${cid}"]`);
    const item   = document.querySelector(`.course-item[data-course-id="${cid}"]`);
    if (!cb || !item) return;

    const course     = S.courses.find(x => x.id === cid);
    const alreadySel = S.selected.has(cid);
    // Seçili değilse AKTS kontrolü, seçiliyse her zaman açık
    const fits       = alreadySel || (remaining >= (course?.akts || 0));

    cb.disabled = !fits;
    item.classList.toggle('locked', !fits);

    if (!fits) {
      const needed = (course?.akts || 0);
      item.title = `Bu ders için ${needed} AKTS gerekli, sadece ${remaining} AKTS boş`;
      disabledCodes.push(course?.code);
    } else {
      item.title = alreadySel ? '' : `Seçilebilir (${course?.akts} AKTS)`;
      unlockedCodes.push(course?.code);
    }
  });

  console.log('[upperAvail]',
    '\n  totalAkts:', [...S.selected].reduce((s,id)=>{const c=S.courses.find(x=>x.id===id);return s+(c?.akts||0);},0),
    '\n  remainingAkts:', remaining,
    '\n  unlockedUpperCourses:', unlockedCodes,
    '\n  disabledUpperCourses (AKTS yetmez):', disabledCodes,
    '\n  selectedUpperCourses:', [...S.selected].filter(id => upperAvailIds.has(id)).map(id => S.courses.find(c=>c.id===id)?.code)
  );
}

function scheduleRebuild() {
  clearTimeout(S._rebuildTimer);
  S._rebuildTimer = setTimeout(doRebuildAll, 350);
}

// ══════════════════════════════════════════════════════
// AKTS GÖSTERİMİ
// ══════════════════════════════════════════════════════
function updateAktsDisplay(total, over) {
  const pct = Math.min((total/30)*100, 100);
  document.getElementById('akts-total').textContent = total;
  document.getElementById('akts-badge').textContent = `${total} AKTS`;
  const bar = document.getElementById('akts-bar');
  bar.style.width = pct+'%'; bar.classList.toggle('over', over);
  const w = document.getElementById('akts-warning');
  if (over) {
    w.className='warning-chip error'; w.textContent=`⚠ AKTS Sınırı Aşıldı! ${total}/30`;
    w.classList.remove('hidden');
  } else { w.classList.add('hidden'); }
}

// ══════════════════════════════════════════════════════
// HOCA ATAMA PANELİ
// ══════════════════════════════════════════════════════
function renderStudentSelect() {
  const sel = document.getElementById('student-select');
  sel.innerHTML = '<option value="">— Öğrenci Seçin —</option>';
  S.students.forEach(s => {
    const o = document.createElement('option');
    o.value = s.id; o.textContent = `${s.name} (${s.class_level}. Sınıf)`;
    sel.appendChild(o);
  });
}

function renderInstructorPanel() {
  const list = document.getElementById('instructor-assign-list');
  list.innerHTML = '';
  const active = S.courses.filter(c => S.selected.has(c.id));
  if (!active.length) {
    list.innerHTML = '<div class="instructor-empty">Ders seçin → hoca ataması görünür.</div>';
    return;
  }
  active.forEach(c => {
    const cur = S.imap[c.id] || 0;
    const row = document.createElement('div'); row.className = 'instructor-row';
    const opts = S.instructors.map(i =>
      `<option value="${i.id}" ${cur===i.id?'selected':''}>${i.name}</option>`
    ).join('');
    row.innerHTML = `
      <span class="instructor-course-code">${c.code}</span>
      <select class="instructor-select ${!cur?'unassigned':''}" data-course-id="${c.id}">
        <option value="0">– Seç –</option>${opts}
      </select>`;
    const sel = row.querySelector('select');
    sel.addEventListener('change', async e => {
      const iid = parseInt(e.target.value)||null;
      await api(`/courses/${c.id}/assign`, {method:'POST', body:JSON.stringify({instructor_id:iid||0})});
      S.imap[c.id] = iid;
      const course = S.courses.find(x=>x.id===c.id); if(course) course.instructor_id=iid;
      sel.classList.toggle('unassigned', !iid);
      scheduleRebuild();
    });
    list.appendChild(row);
  });
}

async function resetInstructors() {
  if (!confirm('Tüm hoca atamaları sıfırlanacak?')) return;
  await Promise.all([...S.selected].map(cid =>
    api(`/courses/${cid}/assign`, {method:'POST', body:JSON.stringify({instructor_id:0})})
  ));
  [...S.selected].forEach(cid => { S.imap[cid]=null; const c=S.courses.find(x=>x.id===cid); if(c)c.instructor_id=null; });
  renderInstructorPanel(); scheduleRebuild();
}

function renderClassroomList() {
  const list = document.getElementById('classroom-list'); list.innerHTML='';
  S.classrooms.forEach(cl => {
    const row=document.createElement('div'); row.className='classroom-row';
    row.innerHTML=`<span class="classroom-name">${cl.name}</span><span class="classroom-capacity-badge">${cl.capacity} kişi</span>`;
    list.appendChild(row);
  });
}

// ══════════════════════════════════════════════════════
// RENDER PIPELINE — SADECE selectedCourses (Madde 7, 10)
// ══════════════════════════════════════════════════════
async function doRebuildAll() {
  const ids = [...S.selected];
  const container = document.getElementById('conflict-graph-container');
  destroyGraph();

  if (!ids.length) {
    ph('conflict-graph-container', 'Ders seçin → graf oluşur');
    updateBadges(0,0,0,0); updateWarningPanel([],0); return;
  }

  showLoading(container);

  // Backend: SADECE seçili dersler
  const result = await api('/dynamic-conflicts', {
    method: 'POST',
    body: JSON.stringify({ course_ids: ids, algorithm: S.algorithm })
  });
  if (!result) { hideLoading(container); return; }

  S.simSteps = result.simulation_steps || [];

  // Node listesi — sadece seçili dersler, String key ile lookup
  const nodes = ids.map(cid => {
    const sk   = String(cid);
    const base = S.courses.find(c => c.id === cid) || {};
    const ci   = result.colorings?.[sk]            ?? -1;
    return {
      ...base, id: cid,
      color_index:        ci,
      color:              sc(ci),
      color_name:         scn(ci),
      degree:             result.degrees?.[sk]              ?? 0,
      student_count:      result.student_counts?.[sk]       ?? 0,
      instructor_name:    result.instructor_names?.[sk]     ?? 'Atanmadı',
      classroom_name:     result.classroom_names?.[sk]      ?? 'Atanmadı',
      classroom_capacity: result.classroom_capacities?.[sk] ?? 0,
      capacity_error:     result.capacity_errors?.[sk]      ?? false,
    };
  });

  const edges = (result.edges||[]).map(e => ({
    ...e,
    color: e.type==='student'?'#f78080': e.type==='instructor'?'#f7d080':'#7a8aa5'
  }));

  console.log('[rebuildAll]',
    '\n  renderedNodeIds:', nodes.map(n=>n.code),
    '\n  renderedEdgeCount:', edges.length,
    '\n  chromatic:', result.chromatic_number,
    '\n  filteredCourses:', ids
  );

  updateBadges(result.chromatic_number, result.lower_bound, nodes.length, edges.length);
  updateWarningPanel(result.warnings||[], result.conflict_count||0);

  hideLoading(container);
  drawConflictGraph(container, nodes, edges);
  drawLegend(nodes);

  // Diğer grafları ve algoritma karşılaştırmasını güncelle
  doRebuildBipartite();
  doRebuildStudentGraph();
  doCompareAlgorithms(ids);
}

// ══════════════════════════════════════════════════════
// ALGORİTMA KARŞILAŞTIRMA PANELİ (Madde 6-9)
// ══════════════════════════════════════════════════════
async function doCompareAlgorithms(ids) {
  if (!ids || ids.length < 2) {
    document.getElementById('algo-compare').style.display = 'none';
    return;
  }

  const result = await api('/compare-algorithms', {
    method: 'POST',
    body: JSON.stringify({ course_ids: ids })
  });
  if (!result) return;

  const panel = document.getElementById('algo-compare');
  panel.style.display = 'block';

  document.getElementById('cmp-greedy').textContent = result.greedy;
  document.getElementById('cmp-dsatur').textContent = result.dsatur;

  const resultEl = document.getElementById('cmp-result');
  if (result.better === 'dsatur') {
    resultEl.innerHTML = `<span style="color:var(--mint)">✓ DSATUR ${result.diff} slot daha az kullandı</span>`;
  } else if (result.better === 'greedy') {
    resultEl.innerHTML = `<span style="color:var(--peach)">Greedy ${result.diff} slot daha az kullandı</span>`;
  } else {
    resultEl.innerHTML = `<span style="color:var(--text-muted)">İki algoritma aynı sonucu verdi</span>`;
  }

  console.log('[AlgoCompare] Greedy:', result.greedy, 'DSATUR:', result.dsatur,
              'Fark:', result.diff, 'Kazanan:', result.better);
}

// ══════════════════════════════════════════════════════
// ÇAKIŞMA GRAFI — D3.js (Madde 7)
// ══════════════════════════════════════════════════════
function drawConflictGraph(container, nodes, edges) {
  destroyGraph();
  d3.select(container).select('.graph-placeholder').style('display','none');
  if (!nodes.length) { ph('conflict-graph-container','Ders yok'); return; }

  const rect=container.getBoundingClientRect();
  const W=rect.width||700, H=rect.height||370;
  const n=nodes.length;
  const rep=Math.min(-700,-200*Math.sqrt(n));
  const ld=Math.min(130,55+n*5);
  const cr=Math.min(44,22+n);

  const svg=d3.select(container).append('svg').attr('width',W).attr('height',H);
  svg.append('defs').append('pattern').attr('id','gp').attr('width',30).attr('height',30)
    .attr('patternUnits','userSpaceOnUse')
    .append('path').attr('d','M30 0L0 0 0 30').attr('fill','none').attr('stroke','#2a2440').attr('stroke-width','0.6');
  svg.append('rect').attr('width',W).attr('height',H).attr('fill','url(#gp)');

  const g=svg.append('g');
  const zoom=d3.zoom().scaleExtent([0.15,5]).on('zoom',e=>g.attr('transform',e.transform));
  svg.call(zoom);
  svg.on('dblclick.zoom',()=>svg.transition().duration(500).call(zoom.transform,d3.zoomIdentity));

  const simNodes=nodes.map(d=>({...d}));
  const idMap={}; simNodes.forEach(d=>idMap[d.id]=d);
  const simLinks=edges.map(e=>({
    source:idMap[e.source]||e.source, target:idMap[e.target]||e.target,
    reason:e.reason, type:e.type, color:e.color
  }));

  const sim=d3.forceSimulation(simNodes)
    .force('link',      d3.forceLink(simLinks).id(d=>d.id).distance(ld).strength(0.25))
    .force('charge',    d3.forceManyBody().strength(rep).distanceMax(500))
    .force('center',    d3.forceCenter(W/2,H/2))
    .force('collision', d3.forceCollide(cr).strength(0.95).iterations(4))
    .force('x',         d3.forceX(W/2).strength(0.03))
    .force('y',         d3.forceY(H/2).strength(0.03))
    .alphaDecay(0.022).velocityDecay(0.45);

  S._sim=sim; S.frozen=false; updateFreezeBtn();

  const ls=g.append('g').selectAll('line').data(simLinks).join('line')
    .attr('stroke',d=>d.color).attr('stroke-width',d=>d.type==='student'?2.5:1.5)
    .attr('stroke-opacity',0.8).attr('cursor','pointer')
    .on('mouseover',(e,d)=>ttEdge(e,d)).on('mousemove',e=>ttMove(e)).on('mouseout',ttHide);
  S._links=ls;

  const ns=g.append('g').selectAll('g').data(simNodes).join('g').attr('class','graph-node')
    .call(d3.drag()
      .on('start',(e,d)=>{if(S.frozen)return;if(!e.active)sim.alphaTarget(.3).restart();d.fx=d.x;d.fy=d.y;})
      .on('drag', (e,d)=>{if(!S.frozen){d.fx=e.x;d.fy=e.y;}})
      .on('end',  (e,d)=>{if(S.frozen)return;if(!e.active)sim.alphaTarget(0);d.fx=null;d.fy=null;})
    );

  ns.append('circle')
    .attr('r',d=>18+Math.min(d.degree*1.5,10))
    .attr('fill',d=>d.capacity_error?'#f78080':d.color)
    .attr('stroke',d=>d.capacity_error?'#b71c1c':d3.color(d.color).darker(1.2))
    .attr('stroke-width',2.5)
    .on('mouseover',(e,d)=>ttNode(e,d)).on('mousemove',e=>ttMove(e)).on('mouseout',ttHide);

  ns.append('text').text(d=>d.code)
    .attr('font-size','9px').attr('font-family','JetBrains Mono,monospace')
    .attr('font-weight','700').attr('fill','#1a1625')
    .attr('text-anchor','middle').attr('dominant-baseline','central').attr('pointer-events','none');

  sim.on('tick',()=>{
    ls.attr('x1',d=>d.source.x).attr('y1',d=>d.source.y)
      .attr('x2',d=>d.target.x).attr('y2',d=>d.target.y);
    ns.attr('transform',d=>`translate(${d.x},${d.y})`);
  });
  sim.on('end',()=>freezeGraph());

  S._nodes=ns;
}

function drawLegend(nodes) {
  const leg=document.getElementById('conflict-legend'); leg.innerHTML='';
  [...new Set(nodes.map(n=>n.color_index))].sort().slice(0,10).forEach(ci=>{
    if(ci<0)return;
    const d=document.createElement('div'); d.className='legend-item';
    d.innerHTML=`<div class="legend-dot" style="background:${sc(ci)}"></div><span>Slot ${ci+1}</span>`;
    leg.appendChild(d);
  });
  [{c:'#f78080',l:'Öğrenci'},{c:'#f7d080',l:'Hoca'},{c:'#7a8aa5',l:'Derslik',dash:true}].forEach(({c,l,dash})=>{
    const d=document.createElement('div'); d.className='legend-item';
    d.innerHTML=`<div class="legend-line" style="${dash?`border-top:2px dashed ${c};background:none`:`background:${c}`}"></div><span>${l}</span>`;
    leg.appendChild(d);
  });
}

// ══════════════════════════════════════════════════════
// BİPARTİT GRAF — sadece seçili dersler (Madde 11)
// ══════════════════════════════════════════════════════
async function doRebuildBipartite() {
  const container=document.getElementById('bipartite-graph-container');
  const ids=[...S.selected];
  if (!ids.length) { d3.select(container).selectAll('svg').remove(); ph('bipartite-graph-container','Ders seçin → bipartit graf'); return; }

  showLoading(container);
  const data=await api('/bipartite-graph?course_ids='+ids.join(','));
  if (!data) { hideLoading(container); return; }
  hideLoading(container);
  d3.select(container).selectAll('svg').remove();
  d3.select(container).select('.graph-placeholder').style('display','none');

  const {courses,classrooms,edges}=data;
  if(!courses.length){ph('bipartite-graph-container','Seçili ders yok');return;}

  const rect=container.getBoundingClientRect();
  const W=rect.width||700, H=rect.height||370;
  const svg=d3.select(container).append('svg').attr('width',W).attr('height',H);
  const g=svg.append('g');
  svg.call(d3.zoom().scaleExtent([.2,4]).on('zoom',e=>g.attr('transform',e.transform)));

  const lx=W*0.25, rx=W*0.75;
  const cp={},dp={};
  courses.forEach((c,i)    =>{cp[c.id]={x:lx,y:(H/(courses.length+1))*(i+1)};});
  classrooms.forEach((cl,i)=>{dp[cl.id]={x:rx,y:(H/(classrooms.length+1))*(i+1)};});

  const valid=edges.filter(e=>!e.is_over_capacity);
  const over =edges.filter(e=>e.is_over_capacity&&e.is_assigned);

  g.append('g').selectAll('line').data(valid).join('line')
    .attr('x1',e=>(cp[e.course_id]||{x:lx}).x).attr('y1',e=>(cp[e.course_id]||{y:0}).y)
    .attr('x2',e=>(dp[e.classroom_id]||{x:rx}).x).attr('y2',e=>(dp[e.classroom_id]||{y:0}).y)
    .attr('stroke',e=>e.is_assigned?'#a7f7d4':'#3d3460')
    .attr('stroke-width',e=>e.is_assigned?2.5:0.7).attr('stroke-opacity',e=>e.is_assigned?0.9:0.2);

  g.append('g').selectAll('line').data(over).join('line')
    .attr('x1',e=>(cp[e.course_id]||{x:lx}).x).attr('y1',e=>(cp[e.course_id]||{y:0}).y)
    .attr('x2',e=>(dp[e.classroom_id]||{x:rx}).x).attr('y2',e=>(dp[e.classroom_id]||{y:0}).y)
    .attr('stroke','#f78080').attr('stroke-width',2).attr('stroke-dasharray','5,3');

  const cn=g.append('g').selectAll('g').data(courses).join('g').attr('transform',c=>`translate(${cp[c.id].x},${cp[c.id].y})`);
  cn.append('rect').attr('x',-40).attr('y',-12).attr('width',80).attr('height',24).attr('rx',6).attr('fill','#2a2440').attr('stroke','#c4a7f7').attr('stroke-width',1.5);
  cn.append('text').attr('text-anchor','middle').attr('dominant-baseline','central').attr('fill','#c4a7f7').attr('font-family','JetBrains Mono').attr('font-size','10px').attr('font-weight','700').text(d=>d.code);
  cn.append('text').attr('x',-48).attr('text-anchor','end').attr('dominant-baseline','central').attr('fill','#9b93c4').attr('font-size','9px').text(d=>`${d.student_count||0} öğr.`);

  const dn=g.append('g').selectAll('g').data(classrooms).join('g').attr('transform',cl=>`translate(${dp[cl.id].x},${dp[cl.id].y})`);
  dn.append('rect').attr('x',-45).attr('y',-12).attr('width',90).attr('height',24).attr('rx',6).attr('fill','#2a2440').attr('stroke','#a7f7d4').attr('stroke-width',1.5);
  dn.append('text').attr('text-anchor','middle').attr('dominant-baseline','central').attr('fill','#a7f7d4').attr('font-family','JetBrains Mono').attr('font-size','9px').attr('font-weight','600').text(d=>d.name.replace('Derslik ',''));
  dn.append('text').attr('x',50).attr('text-anchor','start').attr('dominant-baseline','central').attr('fill','#f7d4a7').attr('font-size','9px').text(d=>`${d.capacity}`);

  svg.append('text').attr('x',lx).attr('y',18).attr('text-anchor','middle').attr('fill','#c4a7f7').attr('font-family','JetBrains Mono').attr('font-size','11px').attr('font-weight','700').text('DERSLER');
  svg.append('text').attr('x',rx).attr('y',18).attr('text-anchor','middle').attr('fill','#a7f7d4').attr('font-family','JetBrains Mono').attr('font-size','11px').attr('font-weight','700').text('DERSLİKLER');
}

// ══════════════════════════════════════════════════════
// ÖĞRENCİ GRAFI — reaktif, her seçimde yeniden (Madde 12)
// ══════════════════════════════════════════════════════
async function doRebuildStudentGraph() {
  if (!S.studentId) return;
  const container=document.getElementById('student-graph-container');
  d3.select(container).selectAll('svg').remove();
  const ids=[...S.selected];
  if (!ids.length) { ph('student-graph-container','Ders seçin → öğrenci grafı'); return; }

  showLoading(container);
  const data=await api(`/student-graph/${S.studentId}?algorithm=${S.algorithm}&course_ids=${ids.join(',')}`);
  hideLoading(container);

  if (!data?.nodes?.length) { ph('student-graph-container','Bu seçimde çizilecek ders yok'); return; }
  d3.select(container).select('.graph-placeholder').style('display','none');

  const rect=container.getBoundingClientRect();
  const W=rect.width||700, H=rect.height||370;
  const svg=d3.select(container).append('svg').attr('width',W).attr('height',H);
  const g=svg.append('g');
  svg.call(d3.zoom().scaleExtent([.2,4]).on('zoom',e=>g.attr('transform',e.transform)));

  const nodes=data.nodes.map(n=>({...n}));
  const nm={}; nodes.forEach(n=>nm[n.id]=n);
  const links=data.edges.map(e=>({source:nm[e.source]||e.source,target:nm[e.target]||e.target,reason:e.reason}));

  const sim=d3.forceSimulation(nodes)
    .force('link',     d3.forceLink(links).id(d=>d.id).distance(110))
    .force('charge',   d3.forceManyBody().strength(-420))
    .force('center',   d3.forceCenter(W/2,H/2))
    .force('collision',d3.forceCollide(32).strength(1));

  const ls=g.append('g').selectAll('line').data(links).join('line')
    .attr('stroke','#f78080').attr('stroke-width',2.5).attr('stroke-opacity',.85)
    .on('mouseover',(e,d)=>ttEdge(e,d)).on('mousemove',e=>ttMove(e)).on('mouseout',ttHide);

  const ns=g.append('g').selectAll('g').data(nodes).join('g')
    .call(d3.drag()
      .on('start',(e,d)=>{if(!e.active)sim.alphaTarget(.3).restart();d.fx=d.x;d.fy=d.y;})
      .on('drag', (e,d)=>{d.fx=e.x;d.fy=e.y;})
      .on('end',  (e,d)=>{if(!e.active)sim.alphaTarget(0);d.fx=null;d.fy=null;})
    );

  ns.append('circle').attr('r',22).attr('fill',d=>d.color).attr('stroke',d=>d3.color(d.color).darker(1.2)).attr('stroke-width',3)
    .on('mouseover',(e,d)=>ttNode(e,d,'s')).on('mousemove',e=>ttMove(e)).on('mouseout',ttHide);
  ns.append('text').attr('text-anchor','middle').attr('dominant-baseline','central')
    .attr('fill','#1a1625').attr('font-family','JetBrains Mono').attr('font-size','9px')
    .attr('font-weight','700').attr('pointer-events','none').text(d=>d.code);

  sim.on('tick',()=>{
    ls.attr('x1',d=>d.source.x).attr('y1',d=>d.source.y).attr('x2',d=>d.target.x).attr('y2',d=>d.target.y);
    ns.attr('transform',d=>`translate(${d.x},${d.y})`);
  });

  if (data.student) {
    svg.append('text').attr('x',12).attr('y',20).attr('fill','#9b93c4')
      .attr('font-family','JetBrains Mono').attr('font-size','11px')
      .text(`${data.student.name} • ${data.student.class_level}. Sınıf • ${data.total_akts} AKTS`);
  }
}

// ══════════════════════════════════════════════════════
// PROGRAM OLUŞTUR — sadece seçili dersler (Madde 9)
// ══════════════════════════════════════════════════════
async function doGenerateSchedule() {
  const ids = [...S.selected];
  if (!ids.length) { toast('Ders seçin!', 'warning'); return; }

  console.log('[generateSchedule] course_ids:', ids);

  const btn=document.getElementById('btn-generate');
  btn.disabled=true; btn.textContent='⟳ Oluşturuluyor...';
  resetSim();

  const data=await api('/generate-schedule',{
    method:'POST',
    body:JSON.stringify({algorithm:S.algorithm, mode:S.mode, course_ids:ids})
  });
  btn.disabled=false; btn.innerHTML='<span>▶</span> Program Oluştur';
  if (!data) return;

  S.simSteps=data.simulation_steps||[];
  updateBadges(data.chromatic_number,data.lower_bound,ids.length,data.total_edges||0);
  renderSchedule(data.schedule_grid);
  showSuccessBanner(data);

  console.log('[generateSchedule] rendered:',
    data.schedule_grid?.type, 'chromatic:', data.chromatic_number
  );
}

function renderSchedule(grid) {
  const c=document.getElementById('schedule-container');
  c.querySelectorAll('table,.exam-schedule,.section-title,.schedule-placeholder').forEach(el=>el.remove());
  if (!grid) { c.innerHTML='<div class="schedule-placeholder">Veri yok.</div>'; return; }
  if (grid.type==='weekly') drawWeekly(c,grid);
  else if (grid.type==='exam') drawExam(c,grid);
}

function drawWeekly(container,grid) {
  const t=document.createElement('div'); t.className='section-title'; t.textContent='HAFTALIK DERS PROGRAMI'; container.appendChild(t);
  const tbl=document.createElement('table'); tbl.className='schedule-grid-week';
  const hr=tbl.createTHead().insertRow();
  hr.insertCell().innerHTML='<th class="time-cell">Saat</th>';
  grid.days.forEach(d=>{const th=document.createElement('th');th.textContent=d.slice(0,3);hr.appendChild(th);});
  const tb=tbl.createTBody();
  grid.hours.forEach(hour=>{
    const row=tb.insertRow(); const tc=row.insertCell(); tc.className='time-cell'; tc.textContent=hour;
    grid.days.forEach(day=>{
      const cell=row.insertCell();
      (grid.grid[day]?.[hour]||[]).forEach(cr=>{
        const b=document.createElement('div'); b.className='schedule-course-block';
        b.style.background=cr.color; b.innerHTML=`<strong>${cr.code}</strong>`;
        b.title=`${cr.name}\n${cr.instructor}\n${cr.classroom}`; cell.appendChild(b);
      });
    });
  });
  container.appendChild(tbl);
}

function drawExam(container,grid) {
  const t=document.createElement('div'); t.className='section-title'; t.textContent='SINAV PROGRAMI'; container.appendChild(t);
  const ed=document.createElement('div'); ed.className='exam-schedule';
  const byDay={};
  grid.sessions.forEach(s=>{if(!byDay[s.day])byDay[s.day]=[];byDay[s.day].push(s);});
  Object.entries(byDay).forEach(([day,sessions])=>{
    const dg=document.createElement('div'); dg.className='exam-day-group';
    const hdr=document.createElement('div'); hdr.className='exam-day-header'; hdr.textContent=day; dg.appendChild(hdr);
    sessions.forEach(s=>{
      if(!s.courses?.length)return;
      const sd=document.createElement('div'); sd.className='exam-session';
      sd.innerHTML=`<div class="exam-session-label">${s.session}</div>
        <div class="exam-course-chips">${s.courses.map(cr=>`<span class="exam-chip" style="background:${cr.color}">${cr.code}</span>`).join('')}</div>`;
      dg.appendChild(sd);
    });
    ed.appendChild(dg);
  });
  container.appendChild(ed);
}

function showSuccessBanner(data) {
  document.querySelector('.schedule-success-banner')?.remove();
  const c=document.getElementById('schedule-container');
  const b=document.createElement('div'); b.className='schedule-success-banner';
  b.innerHTML=`<span class="success-icon">✓</span><span>Program oluşturuldu!</span>
    <span class="success-stats">${data.chromatic_number} slot &nbsp;•&nbsp; ${(data.algorithm||S.algorithm).toUpperCase()} &nbsp;•&nbsp; Alt sınır: ${data.lower_bound}</span>`;
  c.insertBefore(b,c.firstChild);
  setTimeout(()=>b.classList.add('fade-out'),4000); setTimeout(()=>b.remove(),4600);
}

// ══════════════════════════════════════════════════════
// BADGES & WARNINGS
// ══════════════════════════════════════════════════════
function updateBadges(ch,lo,n,e) {
  document.getElementById('stat-chromatic').textContent=ch||'–';
  document.getElementById('stat-lower').textContent=lo||'–';
  document.getElementById('stat-nodes').textContent=n||'–';
  document.getElementById('stat-edges').textContent=e||'–';
  document.getElementById('stat-conflicts').textContent=e||'0';
  document.getElementById('math-chromatic').textContent=ch?`χ(G)=${ch}`:'–';
  document.getElementById('math-lower').textContent=lo?`ω(G)≥${lo}`:'–';
  document.getElementById('math-nodes').textContent=n?`|V|=${n}`:'–';
  document.getElementById('math-edges').textContent=e?`|E|=${e}`:'–';
  document.getElementById('math-algo').textContent=S.algorithm.toUpperCase();
}

function updateWarningPanel(warnings,conflictCount) {
  const list=document.getElementById('warnings-list');
  const cnt=document.getElementById('warning-count');
  list.innerHTML=''; cnt.textContent=warnings.length;
  if (!warnings.length) {
    list.innerHTML=conflictCount===0
      ?'<div class="no-warnings success-msg">✓ Çakışma yok — uyumlu</div>'
      :'<div class="no-warnings">✓ Aktif uyarı yok</div>';
    return;
  }
  warnings.forEach(w=>{
    const chip=document.createElement('div'); chip.className=`warning-chip ${w.severity||'info'}`;
    chip.textContent=w.message; list.appendChild(chip);
  });
}

// ══════════════════════════════════════════════════════
// SIMÜLASYON
// ══════════════════════════════════════════════════════
function toggleSim(){S.simRunning?pauseSim():startSim();}

function startSim(){
  if(!S.simSteps.length){addLog({node_code:'SİSTEM',reason:'Önce Program Oluştur butonuna basın',color:'#5c5480',color_index:-1},-1);return;}
  S.simRunning=true;
  document.getElementById('btn-sim-start').textContent='⏸ Durdur';
  document.getElementById('btn-sim-step').disabled=false;
  const sp=parseInt(document.getElementById('sim-speed').value);
  S.simTimer=setInterval(()=>{if(S.simIdx>=S.simSteps.length){pauseSim();return;}simStep();},sp);
}

function pauseSim(){
  S.simRunning=false; clearInterval(S.simTimer);
  document.getElementById('btn-sim-start').textContent='▶ Başlat';
}

function simStep(){
  if(S.simIdx>=S.simSteps.length)return;
  const step=S.simSteps[S.simIdx]; addLog(step,S.simIdx);
  if(S._nodes){
    S._nodes.select('circle')
      .attr('stroke-width',d=>d.id===step.node_id?4.5:2.5)
      .attr('stroke',d=>d.id===step.node_id?'#fff':d3.color(d.color).darker(1.2));
  }
  S.simIdx++;
  if(S.simIdx>=S.simSteps.length){pauseSim();addLog({node_code:'✓ BİTTİ',reason:`${S.simSteps.length} düğüm boyandı`,color:'#a7f7d4',color_index:-1},-1);}
}

function resetSim(){
  pauseSim(); S.simIdx=0;
  document.getElementById('sim-log').innerHTML='<div class="sim-log-empty">Simülasyonu başlatın → adım adım renklendirme.</div>';
  document.getElementById('btn-sim-step').disabled=true;
}

function addLog(step,idx){
  const log=document.getElementById('sim-log');
  log.querySelector('.sim-log-empty')?.remove();
  log.querySelectorAll('.current').forEach(el=>el.classList.remove('current'));
  const e=document.createElement('div'); e.className='sim-log-entry current';
  e.innerHTML=`<span class="sim-step-num">${idx>=0?idx+1:'–'}</span>
    <span class="sim-node" style="color:${step.color}">${step.node_code}</span>
    <div class="sim-color-dot" style="background:${step.color}"></div>
    <span class="sim-reason">${step.reason}</span>`;
  log.appendChild(e); log.scrollTop=log.scrollHeight;
}

// ══════════════════════════════════════════════════════
// TOOLTIP
// ══════════════════════════════════════════════════════
function ttNode(e,d,type){
  const tip=document.getElementById('tooltip'); tip.classList.remove('hidden');
  let h=`<div class="tooltip-title">${d.code} — ${d.name}</div>`;
  if(type!=='s'){
    h+=`<div class="tooltip-row"><span class="tooltip-key">Hoca</span><span class="tooltip-val">${d.instructor_name||'–'}</span></div>
      <div class="tooltip-row"><span class="tooltip-key">Derslik</span><span class="tooltip-val">${d.classroom_name||'–'}</span></div>
      <div class="tooltip-row"><span class="tooltip-key">Öğrenci</span><span class="tooltip-val">${d.student_count||0}</span></div>`;
    if(d.capacity_error)h+=`<div class="tooltip-reason">⚠ Kapasite aşımı</div>`;
  }
  h+=`<div class="tooltip-row"><span class="tooltip-key">AKTS</span><span class="tooltip-val">${d.akts}</span></div>
    <div class="tooltip-row"><span class="tooltip-key">Renk/Slot</span><span class="tooltip-val" style="color:${d.color}">${d.color_name||scn(d.color_index)}</span></div>`;
  if(d.degree!==undefined)h+=`<div class="tooltip-row"><span class="tooltip-key">Derece</span><span class="tooltip-val">${d.degree}</span></div>`;
  tip.innerHTML=h; ttMove(e);
}
function ttEdge(e,d){
  const tip=document.getElementById('tooltip'); tip.classList.remove('hidden');
  const src=typeof d.source==='object'?d.source.code:d.source;
  const tgt=typeof d.target==='object'?d.target.code:d.target;
  const lbl={student:'👥 Aynı öğrenci',instructor:'🧑‍🏫 Aynı hoca',classroom:'🏫 Aynı derslik'}[d.type]||'⚡';
  tip.innerHTML=`<div class="tooltip-title">${src} ↔ ${tgt}</div>
    <div class="tooltip-reason" style="margin-top:0;border-top:none">${lbl}</div>
    ${d.reason?`<div class="tooltip-row"><span class="tooltip-key">Detay</span><span class="tooltip-val">${d.reason}</span></div>`:''}`;
  ttMove(e);
}
function ttMove(e){
  const t=document.getElementById('tooltip');
  t.style.left=Math.min(e.clientX+14,window.innerWidth-t.offsetWidth-10)+'px';
  t.style.top=Math.min(e.clientY+14,window.innerHeight-t.offsetHeight-10)+'px';
}
function ttHide(){document.getElementById('tooltip').classList.add('hidden');}

// ══════════════════════════════════════════════════════
// FREEZE
// ══════════════════════════════════════════════════════
function freezeGraph(){if(!S._sim)return;S._sim.stop();if(S._nodes)S._nodes.each(d=>{d.fx=d.x;d.fy=d.y;});S.frozen=true;updateFreezeBtn();}
function toggleFreeze(){
  if(!S._sim)return;
  if(S.frozen){if(S._nodes)S._nodes.each(d=>{d.fx=null;d.fy=null;});S._sim.alphaTarget(.1).restart();S.frozen=false;}
  else freezeGraph();
  updateFreezeBtn();
}
function updateFreezeBtn(){
  const b=document.getElementById('btn-freeze');if(!b)return;
  b.textContent=S.frozen?'🔓 Serbest':'❄ Sabitle'; b.classList.toggle('frozen',S.frozen);
}

// ══════════════════════════════════════════════════════
// RESET (Madde 13)
// ══════════════════════════════════════════════════════
function softReset(){
  pauseSim(); resetSim(); destroyGraph();
  d3.select(document.getElementById('bipartite-graph-container')).selectAll('svg').remove();
  d3.select(document.getElementById('student-graph-container')).selectAll('svg').remove();

  S.studentId=null; S.studentLevel=null; S.regPlan=null;
  S.selected.clear(); S.simSteps=[]; S.simIdx=0;
  S._sim=null; S._nodes=null; S._links=null; S.frozen=false;

  document.getElementById('student-select').value='';
  document.querySelectorAll('.course-item').forEach(item=>{
    const cb=item.querySelector('input'); if(cb){cb.checked=false;cb.disabled=false;}
    item.classList.remove('selected','locked','cat-failed','cat-current','cat-upper');
  });
  document.getElementById('akts-total').textContent='0';
  document.getElementById('akts-badge').textContent='0 AKTS';
  document.getElementById('akts-bar').style.width='0%'; document.getElementById('akts-bar').classList.remove('over');
  document.getElementById('akts-warning').classList.add('hidden');
  document.getElementById('reg-summary')?.classList.remove('visible');
  document.getElementById('reg-failed-alert')?.classList.remove('visible');
  document.getElementById('conflict-legend').innerHTML='';
  document.getElementById('warnings-list').innerHTML='<div class="no-warnings">✓ Sıfırlandı</div>';
  document.getElementById('warning-count').textContent='0';
  document.getElementById('schedule-container').innerHTML='<div class="schedule-placeholder">Öğrenci seçin → ders kayıt planı → Program Oluştur.</div>';
  renderCourseList([],null);
  renderInstructorPanel();
  ['stat-chromatic','stat-lower','stat-nodes','stat-edges','stat-conflicts'].forEach(id=>document.getElementById(id).textContent='–');
  ['math-algo','math-chromatic','math-lower','math-nodes','math-edges'].forEach(id=>document.getElementById(id).textContent='–');
  ph('conflict-graph-container','Öğrenci seçin ve ders kaydı yapın');
  ph('bipartite-graph-container','Ders seçin → bipartit graf');
  ph('student-graph-container','Öğrenci seçin → öğrenci grafı');
  updateFreezeBtn();
}

async function hardReset(){
  if(!confirm('Sistem tamamen sıfırlanacak?'))return;
  try{await fetch('/api/reset');}catch(e){}
  location.reload();
}

// ══════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════
function destroyGraph(){
  d3.select(document.getElementById('conflict-graph-container')).selectAll('svg').remove();
  if(S._sim){S._sim.stop();S._sim=null;} S._nodes=null; S._links=null; S.frozen=false;
}
function clearAllGraphs(){
  destroyGraph();
  d3.select(document.getElementById('bipartite-graph-container')).selectAll('svg').remove();
  d3.select(document.getElementById('student-graph-container')).selectAll('svg').remove();
  ph('conflict-graph-container','Öğrenci seçin');
  ph('bipartite-graph-container','Ders seçin');
  ph('student-graph-container','Öğrenci seçin');
  updateBadges(0,0,0,0); updateWarningPanel([],0);
}

function ph(cid, text){
  const c=document.getElementById(cid); if(!c)return;
  let p=c.querySelector('.graph-placeholder');
  if(!p){p=document.createElement('div');p.className='graph-placeholder';
    p.innerHTML='<div class="placeholder-icon">⬡</div><div class="placeholder-text"></div>';
    c.appendChild(p);}
  p.style.display='';
  const pt=p.querySelector('.placeholder-text'); if(pt)pt.textContent=text;
}

function showLoading(c){
  let ol=c.querySelector('.loading-overlay');
  if(!ol){ol=document.createElement('div');ol.className='loading-overlay';
    ol.innerHTML='<div class="spinner"></div><span style="color:#9b93c4;font-size:12px">Yükleniyor...</span>';
    c.style.position='relative';c.appendChild(ol);}
  ol.style.display='flex';
}
function hideLoading(c){const ol=c.querySelector('.loading-overlay');if(ol)ol.style.display='none';}

function toast(msg, sev='warning'){
  const w=document.getElementById('akts-warning');
  w.className=`warning-chip ${sev}`; w.textContent=`⚠ ${msg}`; w.classList.remove('hidden');
  setTimeout(()=>w.classList.add('hidden'),4000);
}
