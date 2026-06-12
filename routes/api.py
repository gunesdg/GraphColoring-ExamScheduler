"""
API Rotaları - REST Endpoints
"""

from flask import Blueprint, jsonify, request
from models.database import get_db
from models.graph import (
    build_conflict_graph, greedy_coloring, dsatur_coloring,
    build_bipartite_graph, check_constraints, generate_schedule,
    compute_chromatic_lower_bound
)
from collections import defaultdict

api_bp = Blueprint('api', __name__)

# Renk paleti - her renk indeksine bir renk
COLOR_PALETTE = [
    '#4FC3F7',  # 0 - Mavi
    '#81C784',  # 1 - Yeşil
    '#FFB74D',  # 2 - Turuncu
    '#BA68C8',  # 3 - Mor
    '#F06292',  # 4 - Pembe
    '#4DD0E1',  # 5 - Cyan
    '#FFF176',  # 6 - Sarı
    '#A5D6A7',  # 7 - Açık yeşil
    '#90CAF9',  # 8 - Açık mavi
    '#FFAB91',  # 9 - Somon
    '#CE93D8',  # 10 - Lila
    '#80DEEA',  # 11 - Turkuaz
    '#FFCC02',  # 12 - Altın
]

COLOR_NAMES = [
    'Mavi (Slot 1)', 'Yeşil (Slot 2)', 'Turuncu (Slot 3)',
    'Mor (Slot 4)', 'Pembe (Slot 5)', 'Cyan (Slot 6)',
    'Sarı (Slot 7)', 'A.Yeşil (Slot 8)', 'A.Mavi (Slot 9)',
    'Somon (Slot 10)', 'Lila (Slot 11)', 'Turkuaz (Slot 12)',
    'Altın (Slot 13)',
]


def get_color(index):
    if index < 0:
        return '#666666'
    return COLOR_PALETTE[index % len(COLOR_PALETTE)]


def get_color_name(index):
    if index < 0:
        return 'Atanmadı'
    return COLOR_NAMES[index % len(COLOR_NAMES)]


# ─── Reset ─────────────────────────────────────────────────────────────────────

@api_bp.route('/reset')
def reset_session():
    """
    Hard reset: time_slot bilgilerini temizle.
    Frontend location.reload() ile sayfayı yeniler.
    """
    db = get_db()
    db.execute("UPDATE course_assignments SET time_slot = NULL, day_slot = NULL")
    db.commit()
    db.close()
    return jsonify({'status': 'ok'})


# ─── Öğrenciler ────────────────────────────────────────────────────────────────

@api_bp.route('/students')
def get_students():
    db = get_db()
    students = db.execute("SELECT * FROM students ORDER BY class_level, name").fetchall()
    db.close()
    return jsonify([dict(s) for s in students])


@api_bp.route('/students/<int:sid>/courses')
def get_student_courses(sid):
    db = get_db()
    courses = db.execute("""
        SELECT c.id, c.code, c.name, c.akts, c.class_level,
               e.status, c.is_mandatory
        FROM courses c
        JOIN enrollments e ON c.id = e.course_id
        WHERE e.student_id = ?
        ORDER BY c.class_level, c.code
    """, (sid,)).fetchall()
    db.close()
    return jsonify([dict(c) for c in courses])


@api_bp.route('/students/<int:sid>/registration-plan')
def get_registration_plan(sid):
    """
    OBS Ders Kayıt Algoritması (düzeltilmiş):

    KURAL 1: 1. sınıf öğrencileri üstten ders alamaz.
    KURAL 2: Sıra — failed → current → (AKTS boşluğu varsa) upper SEÇENEKLERI
    KURAL 3: Her adımda AKTS kontrolü — 30 aşıldığında dur
    KURAL 4: Upper dersler OTOMATİK seçilmez — sadece SEÇİLEBİLİR hale gelir
             Kullanıcı hangi üstten dersi alacağını kendisi seçer.
    """
    db = get_db()

    student = db.execute("SELECT * FROM students WHERE id=?", (sid,)).fetchone()
    if not student:
        db.close()
        return jsonify({'error': 'Öğrenci bulunamadı'}), 404

    level = student['class_level']

    # Geçilen dersler
    passed_ids = {r['id'] for r in db.execute(
        "SELECT course_id FROM enrollments WHERE student_id=? AND status='passed'",
        (sid,)
    ).fetchall()}

    # ADIM 1: Alttan kalan (failed) dersler — zorunlu seçim
    failed = db.execute("""
        SELECT c.id, c.code, c.name, c.akts, c.class_level, c.is_mandatory
        FROM courses c JOIN enrollments e ON c.id=e.course_id
        WHERE e.student_id=? AND e.status='failed'
        ORDER BY c.class_level, c.code
    """, (sid,)).fetchall()

    failed_ids   = {r['id'] for r in failed}
    running_akts = sum(r['akts'] for r in failed)

    # ADIM 2: Mevcut sınıf dersleri (zorunlu + seçmeli) — AKTS kontrolüyle sırayla ekle
    # Zorunlu dersler önce, seçmeliler sonra listelenir
    current_all = db.execute("""
        SELECT id, code, name, akts, class_level, is_mandatory
        FROM courses
        WHERE class_level=?
        ORDER BY is_mandatory DESC, code
    """, (level,)).fetchall()

    current_new     = []  # AKTS'e sığan current dersler (otomatik seçilecek: sadece zorunlular)
    current_skipped = []  # AKTS nedeniyle sığmayan dersler
    current_elective= []  # Seçmeli dersler — kullanıcı seçer, otomatik eklenmez

    for r in current_all:
        if r['id'] in failed_ids or r['id'] in passed_ids:
            continue
        if r['is_mandatory'] == 0:
            # Seçmeli dersler otomatik seçilmez — ayrı listede tut
            current_elective.append(r)
            continue
        if running_akts + r['akts'] <= 30:
            current_new.append(r)
            running_akts += r['akts']
        else:
            current_skipped.append(r)  # AKTS aşımı nedeniyle eklenemeyen

    remaining_akts = 30 - running_akts

    # ADIM 3: Üstten ders SEÇENEKLERİ
    # KURAL 1: 1. sınıf öğrencisi üstten ALAMAZ
    # KURAL 4: Otomatik eklenmez — sadece seçilebilir hale gelir
    # KURAL 5: TÜM üst sınıf dersleri (zorunlu + seçmeli) açılır, AKTS sınırı UI'da kontrol edilir
    upper_available = []
    can_take_upper  = (level > 1 and level < 4 and remaining_akts > 0)

    if can_take_upper:
        upper_candidates = db.execute("""
            SELECT id, code, name, akts, class_level, is_mandatory
            FROM courses
            WHERE class_level=?
            ORDER BY is_mandatory DESC, code
        """, (level + 1,)).fetchall()
        for r in upper_candidates:
            if r['id'] not in passed_ids:
                upper_available.append(r)
                # UI'da remaining_akts < r['akts'] ise disabled gösterilecek

    db.close()

    def fmt(rows, category):
        return [{'id': r['id'], 'code': r['code'], 'name': r['name'],
                 'akts': r['akts'], 'class_level': r['class_level'],
                 'is_mandatory': r['is_mandatory'], 'category': category} for r in rows]

    # all_courses = otomatik seçilecekler (failed + current_new zorunlular)
    # current_elective ve upper → kullanıcı seçer
    auto_courses = fmt(failed, 'failed') + fmt(current_new, 'current')
    total_auto   = sum(c['akts'] for c in auto_courses)

    return jsonify({
        'student':           dict(student),
        'failed':            fmt(failed, 'failed'),
        'current':           fmt(current_new, 'current'),
        'current_elective':  fmt(current_elective, 'current'),  # Seçmeli — kullanıcı seçer
        'current_skipped':   fmt(current_skipped, 'current'),   # AKTS nedeniyle eklenemeyen
        'upper_available':   fmt(upper_available, 'upper'),     # Kullanıcının seçebileceği üstten
        'upper':             [],
        'all_courses':       auto_courses,                       # Sadece otomatik seçilenler
        'total_akts':        total_auto,
        'remaining_akts':    30 - total_auto,
        'can_take_upper':    can_take_upper,
        'has_failed':        len(failed) > 0,
        'over_limit':        total_auto > 30,
        'skipped_count':     len(current_skipped),
    })


# ─── Dersler ───────────────────────────────────────────────────────────────────

@api_bp.route('/courses')
def get_courses():
    db = get_db()
    courses = db.execute("""
        SELECT c.id, c.code, c.name, c.akts, c.class_level, c.is_mandatory,
               ca.instructor_id, ca.classroom_id, ca.time_slot,
               i.name as instructor_name,
               cl.name as classroom_name, cl.capacity
        FROM courses c
        LEFT JOIN course_assignments ca ON c.id = ca.course_id
        LEFT JOIN instructors i ON ca.instructor_id = i.id
        LEFT JOIN classrooms cl ON ca.classroom_id = cl.id
        ORDER BY c.class_level, c.code
    """).fetchall()
    db.close()
    return jsonify([dict(c) for c in courses])


# ─── Hocalar ───────────────────────────────────────────────────────────────────

@api_bp.route('/instructors')
def get_instructors():
    db = get_db()
    instructors = db.execute("SELECT * FROM instructors ORDER BY name").fetchall()
    db.close()
    return jsonify([dict(i) for i in instructors])


# ─── Derslikler ────────────────────────────────────────────────────────────────

@api_bp.route('/classrooms')
def get_classrooms():
    db = get_db()
    classrooms = db.execute("SELECT * FROM classrooms ORDER BY capacity").fetchall()
    db.close()
    return jsonify([dict(c) for c in classrooms])


@api_bp.route('/classrooms/<int:cid>/capacity', methods=['PUT'])
def update_classroom_capacity(cid):
    data = request.get_json()
    capacity = data.get('capacity')
    if not capacity or capacity < 1:
        return jsonify({'error': 'Geçersiz kapasite'}), 400
    db = get_db()
    db.execute("UPDATE classrooms SET capacity = ? WHERE id = ?", (capacity, cid))
    db.commit()
    db.close()
    return jsonify({'success': True})


# ─── Hoca Atama ────────────────────────────────────────────────────────────────

@api_bp.route('/courses/<int:cid>/assign', methods=['POST'])
def assign_instructor(cid):
    data = request.get_json()
    instructor_id = data.get('instructor_id')
    classroom_id = data.get('classroom_id')

    db = get_db()
    # Atama yoksa oluştur, varsa güncelle
    existing = db.execute(
        "SELECT id FROM course_assignments WHERE course_id = ?", (cid,)
    ).fetchone()

    if existing:
        if instructor_id is not None:
            db.execute(
                "UPDATE course_assignments SET instructor_id = ? WHERE course_id = ?",
                (instructor_id if instructor_id != 0 else None, cid)
            )
        if classroom_id is not None:
            db.execute(
                "UPDATE course_assignments SET classroom_id = ? WHERE course_id = ?",
                (classroom_id if classroom_id != 0 else None, cid)
            )
    else:
        db.execute(
            "INSERT INTO course_assignments(course_id, instructor_id, classroom_id) VALUES(?,?,?)",
            (cid, instructor_id or None, classroom_id or None)
        )

    db.commit()
    db.close()
    return jsonify({'success': True})


# ─── AKTS Kontrolü ─────────────────────────────────────────────────────────────

@api_bp.route('/check-akts', methods=['POST'])
def check_akts():
    data = request.get_json()
    course_ids = data.get('course_ids', [])
    student_id = data.get('student_id')

    if not course_ids:
        return jsonify({'total_akts': 0, 'violations': [], 'warnings': []})

    db = get_db()
    placeholders = ','.join('?' * len(course_ids))
    courses = db.execute(
        f"SELECT id, code, name, akts, class_level FROM courses WHERE id IN ({placeholders})",
        course_ids
    ).fetchall()
    db.close()

    total_akts = sum(c['akts'] for c in courses)
    violations, warnings = check_constraints(course_ids, student_id)

    return jsonify({
        'total_akts': total_akts,
        'violations': violations,
        'warnings': warnings,
        'over_limit': total_akts > 30
    })


# ─── Çakışma Grafı ─────────────────────────────────────────────────────────────

@api_bp.route('/conflict-graph')
def get_conflict_graph():
    mode = request.args.get('mode', 'ders')
    algorithm = request.args.get('algorithm', 'dsatur')

    nodes, edges, adjacency = build_conflict_graph(mode)

    # Renklendirme
    if algorithm == 'dsatur':
        coloring, steps = dsatur_coloring(nodes, adjacency)
    else:
        coloring, steps = greedy_coloring(nodes, adjacency)

    chromatic_number = max(coloring.values()) + 1 if coloring else 0
    lower_bound = compute_chromatic_lower_bound(nodes, adjacency)

    # Node'lara renk bilgisi ekle
    node_list = []
    for nid, ndata in nodes.items():
        color_idx = coloring.get(nid, -1)
        # Öğrenci sayısı
        db = get_db()
        student_count = db.execute(
            "SELECT COUNT(*) FROM enrollments WHERE course_id = ?", (nid,)
        ).fetchone()[0]
        db.close()

        # Kapasite kontrolü: öğrenci sayısı > derslik kapasitesi → capacity_error
        capacity_error = False
        if nodes[nid].get('classroom_capacity') and student_count > nodes[nid]['classroom_capacity']:
            capacity_error = True

        node_list.append({
            **ndata,
            'color_index': color_idx,
            'color': get_color(color_idx),
            'color_name': get_color_name(color_idx),
            'student_count': student_count,
            'degree': len(adjacency.get(nid, set())),
            'capacity_error': capacity_error,
        })

    # Kenar listesi
    edge_list = []
    for e in edges:
        edge_list.append({
            **e,
            'color': '#ef5350' if e.get('type') == 'student' else
                     '#ff9800' if e.get('type') == 'instructor' else '#78909c'
        })

    # Simülasyon adımları için renk bilgisi ekle
    for step in steps:
        step['color'] = get_color(step['color_index'])
        step['color_name'] = get_color_name(step['color_index'])

    return jsonify({
        'nodes': node_list,
        'edges': edge_list,
        'chromatic_number': chromatic_number,
        'lower_bound': lower_bound,
        'algorithm': algorithm,
        'total_nodes': len(nodes),
        'total_edges': len(edges),
        'simulation_steps': steps,
    })


# ─── Öğrenciye Özel Graf ───────────────────────────────────────────────────────

@api_bp.route('/student-graph/<int:sid>')
def get_student_graph(sid):
    """
    FIX 4: course_ids query param ile filtreleme.
    Kullanıcının manuel ders seçimi yansır.
    """
    algorithm  = request.args.get('algorithm', 'dsatur')
    # FIX 4: Frontend'den gelen seçili ders ID'leri (opsiyonel)
    course_ids_param = request.args.get('course_ids', '')
    manual_ids = set(int(x) for x in course_ids_param.split(',') if x.strip().isdigit())

    db = get_db()
    enrollments = db.execute(
        "SELECT course_id FROM enrollments WHERE student_id = ?", (sid,)
    ).fetchall()
    enrolled_ids = {row['course_id'] for row in enrollments}
    student = db.execute("SELECT * FROM students WHERE id = ?", (sid,)).fetchone()
    db.close()

    # FIX 4: Manuel seçim varsa onu kullan, yoksa kayıtlı dersler
    student_course_ids = manual_ids if manual_ids else enrolled_ids

    if not student_course_ids:
        return jsonify({'nodes': [], 'edges': [],
                        'student': dict(student) if student else None,
                        'total_akts': 0, 'over_limit': False})

    nodes, edges, adjacency = build_conflict_graph()

    sub_nodes    = {nid: d for nid, d in nodes.items() if nid in student_course_ids}
    sub_edges    = [e for e in edges
                    if e['source'] in student_course_ids and e['target'] in student_course_ids]
    sub_adjacency= {nid: adj & student_course_ids
                    for nid, adj in adjacency.items() if nid in student_course_ids}

    if algorithm == 'dsatur':
        coloring, _ = dsatur_coloring(sub_nodes, sub_adjacency)
    else:
        coloring, _ = greedy_coloring(sub_nodes, sub_adjacency)

    node_list = [{
        **ndata,
        'color_index': coloring.get(nid, -1),
        'color':       get_color(coloring.get(nid, -1)),
        'color_name':  get_color_name(coloring.get(nid, -1)),
    } for nid, ndata in sub_nodes.items()]

    edge_list    = [{**e, 'color': '#ef5350'} for e in sub_edges]
    total_akts   = sum(n['akts'] for n in sub_nodes.values())

    return jsonify({
        'nodes': node_list, 'edges': edge_list,
        'student': dict(student) if student else None,
        'total_akts': total_akts, 'over_limit': total_akts > 30,
    })


# ─── Bipartit Graf ─────────────────────────────────────────────────────────────

@api_bp.route('/bipartite-graph')
def get_bipartite_graph():
    """
    FIX 3: course_ids query param ile sadece seçili dersleri döndür.
    """
    course_ids_param = request.args.get('course_ids', '')
    filter_ids = set(int(x) for x in course_ids_param.split(',') if x.strip().isdigit())

    courses, classrooms, edges, matching = build_bipartite_graph()

    # FIX 3: Filtrele — seçili dersler varsa sadece onları göster
    if filter_ids:
        courses = [c for c in courses if c['id'] in filter_ids]
        course_id_set = {c['id'] for c in courses}
        edges = [e for e in edges if e['course_id'] in course_id_set]
        matching = {k: v for k, v in matching.items() if k in course_id_set}

    db = get_db()
    student_counts = {}
    rows = db.execute(
        "SELECT course_id, COUNT(*) as cnt FROM enrollments GROUP BY course_id"
    ).fetchall()
    for row in rows:
        student_counts[row['course_id']] = row['cnt']
    db.close()

    for c in courses:
        c['student_count'] = student_counts.get(c['id'], 0)

    return jsonify({
        'courses': courses, 'classrooms': classrooms,
        'edges': edges, 'matching': matching,
    })


# ─── Program Oluştur ───────────────────────────────────────────────────────────

@api_bp.route('/generate-schedule', methods=['POST'])
def generate_schedule_api():
    """
    FIX 3: Sadece seçili dersler üzerinde program oluştur.
    course_ids gönderilirse sadece o dersler kullanılır.
    """
    data = request.get_json() or {}
    algorithm  = data.get('algorithm', 'dsatur')
    mode       = data.get('mode', 'ders')
    course_ids = data.get('course_ids', [])  # FIX 3: seçili ders filtresi

    nodes, edges, adjacency = build_conflict_graph(mode)

    if not nodes:
        return jsonify({'error': 'Veri bulunamadı'}), 404

    # FIX 3: Eğer course_ids verilmişse sadece o node'ları kullan
    if course_ids:
        selected_set = set(course_ids)
        nodes    = {cid: nd for cid, nd in nodes.items() if cid in selected_set}
        edges    = [e for e in edges
                    if e['source'] in selected_set and e['target'] in selected_set]
        adjacency = {cid: adj & selected_set
                     for cid, adj in adjacency.items() if cid in selected_set}

    # Graph coloring
    if algorithm == 'dsatur':
        coloring, steps = dsatur_coloring(nodes, adjacency)
    else:
        coloring, steps = greedy_coloring(nodes, adjacency)

    chromatic_number = max(coloring.values()) + 1 if coloring else 0
    lower_bound = compute_chromatic_lower_bound(nodes, adjacency)

    # Coloring'i node'lara yaz
    for nid, ci in coloring.items():
        nodes[nid]['color_index'] = ci

    # DB'ye kaydet
    db = get_db()
    for nid, ci in coloring.items():
        db.execute(
            "UPDATE course_assignments SET time_slot=? WHERE course_id=?", (ci, nid)
        )
    db.commit(); db.close()

    schedule_grid = _build_schedule_grid(nodes, chromatic_number, mode)

    for step in steps:
        step['color']      = get_color(step['color_index'])
        step['color_name'] = get_color_name(step['color_index'])

    return jsonify({
        'schedule_grid':     schedule_grid,
        'chromatic_number':  chromatic_number,
        'lower_bound':       lower_bound,
        'algorithm':         algorithm,
        'total_slots':       chromatic_number,
        'total_edges':       len(edges),
        'simulation_steps':  steps,
    })


def _build_schedule_grid(nodes, num_slots, mode):
    """Program ızgarasını oluştur"""
    if mode == 'ders':
        days = ['Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma']
        hours = ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00']

        grid = {}
        slot_idx = 0
        for day in days:
            grid[day] = {}
            for hour in hours:
                grid[day][hour] = []

        # Dersleri slotlara yerleştir
        for nid, ndata in nodes.items():
            ci = ndata.get('color_index', -1)
            if ci < 0:
                continue
            slot_idx_local = ci
            # Slotu gün/saate çevir
            total_hours = len(hours)
            day_idx = slot_idx_local // total_hours
            hour_idx = slot_idx_local % total_hours
            if day_idx < len(days) and hour_idx < len(hours):
                day = days[day_idx]
                hour = hours[hour_idx]
                grid[day][hour].append({
                    'id': nid,
                    'code': ndata['code'],
                    'name': ndata['name'],
                    'instructor': ndata.get('instructor_name', ''),
                    'classroom': ndata.get('classroom_name', ''),
                    'color': get_color(ci),
                    'color_index': ci,
                })

        return {'type': 'weekly', 'days': days, 'hours': hours, 'grid': grid}
    else:
        # Sınav programı: Oturumlar
        sessions = []
        for i in range(num_slots):
            day_num = i // 2 + 1
            session_name = 'Sabah (09:00-12:00)' if i % 2 == 0 else 'Öğleden Sonra (14:00-17:00)'
            sessions.append({
                'day': f'Gün {day_num}',
                'session': session_name,
                'slot_index': i,
                'courses': []
            })

        for nid, ndata in nodes.items():
            ci = ndata.get('color_index', -1)
            if ci < 0 or ci >= len(sessions):
                continue
            sessions[ci]['courses'].append({
                'id': nid,
                'code': ndata['code'],
                'name': ndata['name'],
                'instructor': ndata.get('instructor_name', ''),
                'classroom': ndata.get('classroom_name', ''),
                'color': get_color(ci),
                'color_index': ci,
            })

        return {'type': 'exam', 'sessions': sessions}


# ─── Uyarılar ──────────────────────────────────────────────────────────────────

@api_bp.route('/warnings')
def get_warnings():
    """Sistemdeki tüm uyarıları getir"""
    db = get_db()
    warnings = []

    # 1. Hoca atanmamış dersler
    no_instructor = db.execute("""
        SELECT c.code FROM courses c
        LEFT JOIN course_assignments ca ON c.id = ca.course_id
        WHERE ca.instructor_id IS NULL OR ca.id IS NULL
    """).fetchall()
    for row in no_instructor:
        warnings.append({
            'type': 'no_instructor',
            'severity': 'warning',
            'message': f'Hoca atanmadı: {row["code"]}'
        })

    # 2. Kapasite aşımı
    capacity_issues = db.execute("""
        SELECT c.code, cl.capacity, COUNT(e.student_id) as cnt
        FROM courses c
        JOIN course_assignments ca ON c.id = ca.course_id
        JOIN classrooms cl ON ca.classroom_id = cl.id
        JOIN enrollments e ON c.id = e.course_id
        GROUP BY c.id, cl.capacity
        HAVING cnt > cl.capacity
    """).fetchall()
    for row in capacity_issues:
        warnings.append({
            'type': 'capacity',
            'severity': 'warning',
            'message': f'Kapasite yetersiz: {row["code"]} ({row["cnt"]}/{row["capacity"]})'
        })

    # 3. Hoca çakışmaları (birden fazla derse atanmış)
    instructor_conflicts = db.execute("""
        SELECT i.name, GROUP_CONCAT(c.code) as courses, COUNT(*) as cnt
        FROM course_assignments ca
        JOIN instructors i ON ca.instructor_id = i.id
        JOIN courses c ON ca.course_id = c.id
        GROUP BY ca.instructor_id
        HAVING cnt > 1
    """).fetchall()
    for row in instructor_conflicts:
        warnings.append({
            'type': 'instructor_conflict',
            'severity': 'info',
            'message': f'Birden fazla derse atanmış: {row["name"]} → {row["courses"]}'
        })

    db.close()

    # Çakışma grafındaki kenar sayısı (çakışma sayısı)
    nodes, edges, adjacency = build_conflict_graph()
    student_conflicts = [e for e in edges if e.get('type') == 'student']

    # 4. Kapasite hatası: hiç uygun sınıf atanamamış dersler (kırmızı node)
    db2 = get_db()
    all_courses = db2.execute("""
        SELECT c.id, c.code FROM courses c
        LEFT JOIN course_assignments ca ON c.id = ca.course_id
        WHERE ca.classroom_id IS NULL
    """).fetchall()
    for row in all_courses:
        student_cnt = db2.execute(
            "SELECT COUNT(*) FROM enrollments WHERE course_id = ?", (row['id'],)
        ).fetchone()[0]
        # Uygun kapasite var mı?
        suitable = db2.execute(
            "SELECT COUNT(*) FROM classrooms WHERE capacity >= ?", (student_cnt,)
        ).fetchone()[0]
        if suitable == 0 and student_cnt > 0:
            warnings.append({
                'type': 'no_classroom',
                'severity': 'error',
                'message': f'Kapasite yetersiz: {row["code"]} için uygun sınıf yok ({student_cnt} öğrenci)'
            })
    db2.close()

    for sc in student_conflicts[:5]:  # İlk 5 çakışmayı göster
        src_code = nodes.get(sc['source'], {}).get('code', '?')
        tgt_code = nodes.get(sc['target'], {}).get('code', '?')
        warnings.insert(0, {
            'type': 'conflict',
            'severity': 'error',
            'message': f'Çakışma: {src_code} & {tgt_code} ({sc["reason"]})'
        })

    return jsonify({
        'warnings': warnings,
        'total_conflicts': len(student_conflicts),
    })


# ─── Dinamik Çakışma (Ders Seçimi Anında) ─────────────────────────────────────

@api_bp.route('/dynamic-conflicts', methods=['POST'])
def dynamic_conflicts():
    """
    Dinamik çakışma + tam graf verisi (seçili dersler için).
    Alt-graf üzerinde graph coloring çalıştırır, tüm node detaylarını döndürür.
    """
    data = request.get_json() or {}
    course_ids = data.get('course_ids', [])

    if not course_ids:
        return jsonify({
            'conflict_count': 0, 'conflicting_pairs': [], 'warnings': [],
            'edges': [], 'colorings': {}, 'degrees': {},
            'student_counts': {}, 'instructor_names': {}, 'instructor_ids': {},
            'classroom_names': {}, 'classroom_capacities': {}, 'capacity_errors': {},
            'chromatic_number': 0, 'lower_bound': 0, 'simulation_steps': [],
        })

    nodes, edges, adjacency = build_conflict_graph()
    selected_set = set(course_ids)

    sub_nodes = {cid: nd for cid, nd in nodes.items() if cid in selected_set}
    sub_edges = [e for e in edges
                 if e['source'] in selected_set and e['target'] in selected_set]
    sub_adj = {cid: adj & selected_set
               for cid, adj in adjacency.items() if cid in selected_set}

    # Graph coloring — sadece seçili alt-graf
    algo = data.get('algorithm', 'dsatur')
    if algo == 'dsatur':
        coloring, sim_steps = dsatur_coloring(sub_nodes, sub_adj)
    else:
        coloring, sim_steps = greedy_coloring(sub_nodes, sub_adj)

    chromatic_number = max(coloring.values()) + 1 if coloring else 0
    lower_bound = compute_chromatic_lower_bound(sub_nodes, sub_adj)

    for step in sim_steps:
        step['color']      = get_color(step['color_index'])
        step['color_name'] = get_color_name(step['color_index'])

    db = get_db()
    student_counts  = {}
    capacity_errors = {}
    warnings = []

    for cid in course_ids:
        cnt = db.execute(
            "SELECT COUNT(*) FROM enrollments WHERE course_id=?", (cid,)
        ).fetchone()[0]
        student_counts[cid] = cnt
        if cid in sub_nodes:
            cap = sub_nodes[cid].get('classroom_capacity', 0)
            capacity_errors[cid] = bool(cap > 0 and cnt > cap)

    for e in sub_edges:
        src = sub_nodes.get(e['source'], {})
        tgt = sub_nodes.get(e['target'], {})
        if e.get('type') == 'student':
            warnings.append({'type':'conflict','severity':'error',
                'message': f'Çakışma: {src.get("code","?")} & {tgt.get("code","?")} — {e["reason"]}'})
        elif e.get('type') == 'instructor':
            warnings.append({'type':'instructor_conflict','severity':'warning',
                'message': f'Hoca çakışması: {src.get("code","?")} & {tgt.get("code","?")}'})

    for cid in course_ids:
        if cid not in sub_nodes:
            continue
        nd = sub_nodes[cid]
        if capacity_errors.get(cid):
            warnings.append({'type':'capacity','severity':'warning',
                'message': f'Kapasite yetersiz: {nd["code"]} ({student_counts.get(cid,0)}/{nd.get("classroom_capacity",0)})'})
        if not nd.get('instructor_id'):
            warnings.append({'type':'no_instructor','severity':'warning',
                'message': f'Hoca atanmadı: {nd["code"]}'})

    db.close()

    edge_list = [{**e,
        'color': '#ef5350' if e.get('type')=='student'
                 else '#ff9800' if e.get('type')=='instructor' else '#78909c'
    } for e in sub_edges]

    return jsonify({
        'conflict_count':       len(sub_edges),
        'conflicting_pairs':    [[e['source'], e['target']] for e in sub_edges],
        'edges':                edge_list,
        'warnings':             warnings,
        # INT keys — JS'te c.id integer olduğu için str key kullanılırsa undefined döner
        'colorings':            {k: v for k, v in coloring.items()},
        'degrees':              {cid: len(sub_adj.get(cid, set())) for cid in course_ids},
        'student_counts':       {k: v for k, v in student_counts.items()},
        'instructor_names':     {cid: sub_nodes.get(cid,{}).get('instructor_name','Atanmadı') for cid in course_ids},
        'instructor_ids':       {cid: sub_nodes.get(cid,{}).get('instructor_id') for cid in course_ids},
        'classroom_names':      {cid: sub_nodes.get(cid,{}).get('classroom_name','Atanmadı') for cid in course_ids},
        'classroom_capacities': {cid: sub_nodes.get(cid,{}).get('classroom_capacity',0) for cid in course_ids},
        'capacity_errors':      {k: v for k, v in capacity_errors.items()},
        'chromatic_number':     chromatic_number,
        'lower_bound':          lower_bound,
        'simulation_steps':     sim_steps,
    })


# ─── Algoritma Karşılaştırma ───────────────────────────────────────────────────

@api_bp.route('/compare-algorithms', methods=['POST'])
def compare_algorithms():
    """
    Greedy vs DSATUR karşılaştırması.
    Aynı graf üzerinde her iki algoritmayı çalıştır, farkı göster.
    """
    data       = request.get_json() or {}
    course_ids = data.get('course_ids', [])

    if not course_ids:
        return jsonify({'greedy': 0, 'dsatur': 0, 'diff': 0, 'better': 'eşit'})

    nodes, edges, adjacency = build_conflict_graph()
    selected_set = set(course_ids)
    sub_nodes = {cid: nd for cid, nd in nodes.items() if cid in selected_set}
    sub_adj   = {cid: adj & selected_set
                 for cid, adj in adjacency.items() if cid in selected_set}

    if not sub_nodes:
        return jsonify({'greedy': 0, 'dsatur': 0, 'diff': 0, 'better': 'eşit'})

    # Greedy: node'ları sırayla boya, ilk uygun rengi ver
    greedy_col, greedy_steps = greedy_coloring(sub_nodes, sub_adj)
    greedy_n   = max(greedy_col.values()) + 1 if greedy_col else 0

    # DSATUR: saturation degree'ye göre seç, daha optimize
    dsatur_col, dsatur_steps = dsatur_coloring(sub_nodes, sub_adj)
    dsatur_n   = max(dsatur_col.values()) + 1 if dsatur_col else 0

    diff   = greedy_n - dsatur_n
    better = 'dsatur' if dsatur_n < greedy_n else ('greedy' if greedy_n < dsatur_n else 'eşit')

    # Her adıma renk ekle
    for step in greedy_steps:
        step['color'] = get_color(step['color_index'])
    for step in dsatur_steps:
        step['color'] = get_color(step['color_index'])

    return jsonify({
        'greedy':        greedy_n,
        'dsatur':        dsatur_n,
        'diff':          abs(diff),
        'better':        better,
        'greedy_steps':  greedy_steps,
        'dsatur_steps':  dsatur_steps,
        'greedy_coloring': {k: v for k, v in greedy_col.items()},
        'dsatur_coloring': {k: v for k, v in dsatur_col.items()},
    })


# ─── İstatistikler ─────────────────────────────────────────────────────────────

@api_bp.route('/stats')
def get_stats():
    db = get_db()
    stats = {
        'total_students': db.execute("SELECT COUNT(*) FROM students").fetchone()[0],
        'total_courses': db.execute("SELECT COUNT(*) FROM courses").fetchone()[0],
        'total_instructors': db.execute("SELECT COUNT(*) FROM instructors").fetchone()[0],
        'total_classrooms': db.execute("SELECT COUNT(*) FROM classrooms").fetchone()[0],
        'total_enrollments': db.execute("SELECT COUNT(*) FROM enrollments").fetchone()[0],
    }
    db.close()

    # Graf istatistikleri
    nodes, edges, adjacency = build_conflict_graph()
    if nodes:
        coloring, _ = dsatur_coloring(nodes, adjacency)
        chromatic_number = max(coloring.values()) + 1 if coloring else 0
        lower_bound = compute_chromatic_lower_bound(nodes, adjacency)
    else:
        chromatic_number = 0
        lower_bound = 0

    stats['chromatic_number'] = chromatic_number
    stats['lower_bound'] = lower_bound
    stats['total_conflicts'] = len([e for e in edges if e.get('type') == 'student'])
    stats['total_edges'] = len(edges)
    stats['total_nodes'] = len(nodes)

    return jsonify(stats)
