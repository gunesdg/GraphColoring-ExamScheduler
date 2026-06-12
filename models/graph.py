"""
Graf Teorisi Algoritmaları
==========================
Bu modül uygulamanın matematiksel çekirdeğini oluşturur.

1. ÇAKIŞMA GRAFI (Conflict Graph)
   - V = dersler kümesi
   - E = çakışma kenarları (ortak öğrenci, hoca veya derslik)

2. GRAPH COLORING (Greedy + DSATUR)
   - Renk = zaman slotu
   - Kısıt: Komşu node'lar farklı renk almalı
   - Kroma tik sayı = minimum slot sayısı

3. BIPARTITE MATCHING (Ders ↔ Derslik)
   - Sol küme: dersler
   - Sağ küme: derslikler
   - Kapasite kısıtlı eşleştirme
"""

from models.database import get_db
from collections import defaultdict


# ══════════════════════════════════════════════════════════════════════════════
# 1. ÇAKIŞMA GRAFI OLUŞTURMA
# ══════════════════════════════════════════════════════════════════════════════

def build_conflict_graph(mode='ders'):
    """
    Çakışma grafını oluştur.
    
    Graf G = (V, E):
    - V: Sistemdeki tüm dersler
    - E: İki ders arasında şu üç nedenden biri varsa kenar eklenir:
         a) Ortak kayıtlı öğrenci
         b) Aynı hoca atanmış
         c) Aynı derslik atanmış
    
    Returns:
        nodes: {course_id: {code, name, akts, ...}}
        edges: [{source, target, reason}]
        adjacency: {course_id: set(neighbor_ids)}
    """
    db = get_db()

    # Tüm dersleri getir
    courses = db.execute("""
        SELECT c.id, c.code, c.name, c.akts, c.class_level,
               ca.instructor_id, ca.classroom_id, ca.time_slot,
               i.name as instructor_name,
               cl.name as classroom_name, cl.capacity
        FROM courses c
        LEFT JOIN course_assignments ca ON c.id = ca.course_id
        LEFT JOIN instructors i ON ca.instructor_id = i.id
        LEFT JOIN classrooms cl ON ca.classroom_id = cl.id
    """).fetchall()

    nodes = {}
    for row in courses:
        nodes[row['id']] = {
            'id': row['id'],
            'code': row['code'],
            'name': row['name'],
            'akts': row['akts'],
            'class_level': row['class_level'],
            'instructor_id': row['instructor_id'],
            'instructor_name': row['instructor_name'] or 'Atanmadı',
            'classroom_id': row['classroom_id'],
            'classroom_name': row['classroom_name'] or 'Atanmadı',
            'classroom_capacity': row['capacity'] or 0,
            'time_slot': row['time_slot'],
            'color': None,
            'color_index': -1,
        }

    edges = []
    adjacency = defaultdict(set)

    course_ids = list(nodes.keys())

    # ── a) Ortak öğrenci çakışması ─────────────────────────────────────────────
    # İki derste ortak öğrenci varsa → kenar
    student_courses = defaultdict(set)
    enrollments = db.execute("SELECT student_id, course_id FROM enrollments").fetchall()
    for row in enrollments:
        student_courses[row['student_id']].add(row['course_id'])

    student_conflict_pairs = set()
    for sid, cset in student_courses.items():
        clist = sorted(cset)
        for i in range(len(clist)):
            for j in range(i + 1, len(clist)):
                pair = (clist[i], clist[j])
                student_conflict_pairs.add(pair)

    for (c1, c2) in student_conflict_pairs:
        if c1 in nodes and c2 in nodes:
            # Kaç ortak öğrenci var?
            count = db.execute("""
                SELECT COUNT(*) FROM enrollments e1
                JOIN enrollments e2 ON e1.student_id = e2.student_id
                WHERE e1.course_id = ? AND e2.course_id = ?
            """, (c1, c2)).fetchone()[0]
            edges.append({
                'source': c1, 'target': c2,
                'reason': f'Ortak öğrenci ({count} kişi)',
                'type': 'student'
            })
            adjacency[c1].add(c2)
            adjacency[c2].add(c1)

    # ── b) Aynı hoca çakışması ─────────────────────────────────────────────────
    instructor_courses = defaultdict(list)
    for cid, data in nodes.items():
        if data['instructor_id']:
            instructor_courses[data['instructor_id']].append(cid)

    for iid, clist in instructor_courses.items():
        for i in range(len(clist)):
            for j in range(i + 1, len(clist)):
                c1, c2 = clist[i], clist[j]
                pair = (min(c1, c2), max(c1, c2))
                # Student çakışması yoksa kenar ekle
                if pair not in student_conflict_pairs:
                    edges.append({
                        'source': c1, 'target': c2,
                        'reason': f'Aynı hoca: {nodes[c1]["instructor_name"]}',
                        'type': 'instructor'
                    })
                    adjacency[c1].add(c2)
                    adjacency[c2].add(c1)

    # ── c) Aynı derslik çakışması ──────────────────────────────────────────────
    classroom_courses = defaultdict(list)
    for cid, data in nodes.items():
        if data['classroom_id']:
            classroom_courses[data['classroom_id']].append(cid)

    for clid, clist in classroom_courses.items():
        for i in range(len(clist)):
            for j in range(i + 1, len(clist)):
                c1, c2 = clist[i], clist[j]
                pair = (min(c1, c2), max(c1, c2))
                if pair not in student_conflict_pairs:
                    existing = any(
                        e['source'] == c1 and e['target'] == c2 or
                        e['source'] == c2 and e['target'] == c1
                        for e in edges
                    )
                    if not existing:
                        edges.append({
                            'source': c1, 'target': c2,
                            'reason': f'Aynı derslik: {nodes[c1]["classroom_name"]}',
                            'type': 'classroom'
                        })
                        adjacency[c1].add(c2)
                        adjacency[c2].add(c1)

    db.close()
    return nodes, edges, dict(adjacency)


# ══════════════════════════════════════════════════════════════════════════════
# 2. GRAPH COLORING ALGORİTMALARI
# ══════════════════════════════════════════════════════════════════════════════

def greedy_coloring(nodes, adjacency):
    """
    Greedy Graph Coloring Algoritması
    ==================================
    Sıralı boyama: En yüksek dereceli node'dan başla.
    
    Algoritma:
    1. Node'ları dereceye göre azalan sırada sırala
    2. Her node için komşularında kullanılmayan en küçük rengi ata
    
    Karmaşıklık: O(V + E)
    Garanti: Δ+1 renk (Δ = max derece)
    
    Returns:
        coloring: {node_id: color_index}
        steps: Simülasyon adımları
    """
    coloring = {}
    steps = []

    # Dereceye göre sırala (Welsh-Powell sıralaması)
    sorted_nodes = sorted(
        nodes.keys(),
        key=lambda n: len(adjacency.get(n, set())),
        reverse=True
    )

    for node_id in sorted_nodes:
        # Komşuların kullandığı renkleri bul
        neighbor_colors = set()
        for neighbor in adjacency.get(node_id, set()):
            if neighbor in coloring:
                neighbor_colors.add(coloring[neighbor])

        # En küçük kullanılmayan rengi bul
        color = 0
        while color in neighbor_colors:
            color += 1

        coloring[node_id] = color
        reason = (
            f"0 komşu çakışması - ilk renk uygun" if not neighbor_colors
            else f"Komşu renkleri {sorted(neighbor_colors)} kullanımda - renk {color} seçildi"
        )
        steps.append({
            'node_id': node_id,
            'node_code': nodes[node_id]['code'],
            'color_index': color,
            'neighbor_colors': sorted(neighbor_colors),
            'reason': reason
        })

    return coloring, steps


def dsatur_coloring(nodes, adjacency):
    """
    DSATUR (Degree of SATURation) Algoritması
    ==========================================
    Greedy'den daha iyi sonuç verir.
    
    Saturation degree: Farklı renkli komşu sayısı
    
    Algoritma:
    1. Boyanmamış node'lar arasında en yüksek saturation degree'ye bak
    2. Eşitlik durumunda toplam dereceye bak
    3. Seçilen node'a en küçük geçerli rengi ata
    
    Karmaşıklık: O(V² + E)
    Avantaj: Pratikte daha az renk kullanır
    
    Returns:
        coloring: {node_id: color_index}
        steps: Simülasyon adımları
    """
    coloring = {}
    saturation = {n: 0 for n in nodes}  # Doygunluk derecesi
    steps = []

    uncolored = set(nodes.keys())

    while uncolored:
        # En yüksek doygunluk dereceli node'u seç
        # Eşitlikte en yüksek toplam derece
        chosen = max(
            uncolored,
            key=lambda n: (saturation[n], len(adjacency.get(n, set())))
        )

        # Komşuların kullandığı renkler
        neighbor_colors = set()
        for neighbor in adjacency.get(chosen, set()):
            if neighbor in coloring:
                neighbor_colors.add(coloring[neighbor])

        # En küçük geçerli rengi ata
        color = 0
        while color in neighbor_colors:
            color += 1

        coloring[chosen] = color
        uncolored.remove(chosen)

        # Komşuların doygunluğunu güncelle
        for neighbor in adjacency.get(chosen, set()):
            if neighbor in uncolored:
                neighbor_sat = set()
                for nn in adjacency.get(neighbor, set()):
                    if nn in coloring:
                        neighbor_sat.add(coloring[nn])
                saturation[neighbor] = len(neighbor_sat)

        reason = (
            f"Doygunluk={saturation[chosen]}, derece={len(adjacency.get(chosen,set()))}"
            f" → Komşu renkleri: {sorted(neighbor_colors)} → Renk {color} atandı"
        )
        steps.append({
            'node_id': chosen,
            'node_code': nodes[chosen]['code'],
            'color_index': color,
            'saturation': saturation[chosen],
            'neighbor_colors': sorted(neighbor_colors),
            'reason': reason
        })

    return coloring, steps


def compute_chromatic_lower_bound(nodes, adjacency):
    """
    Kroma tik sayının alt sınırını hesapla.
    
    Alt sınır = max clique boyutu (en büyük tam alt graf)
    Burada greedy clique yaklaşımı kullanılır.
    """
    if not nodes:
        return 0

    # En yüksek dereceli node'dan başlayarak clique büyüt
    max_clique_size = 1
    sorted_nodes = sorted(
        nodes.keys(),
        key=lambda n: len(adjacency.get(n, set())),
        reverse=True
    )

    for start in sorted_nodes[:5]:  # İlk 5 node'dan dene
        clique = {start}
        candidates = set(adjacency.get(start, set()))
        while candidates:
            # Tüm clique üyeleriyle komşu olan bir node seç
            best = None
            for c in candidates:
                if all(c in adjacency.get(m, set()) for m in clique):
                    best = c
                    break
            if best is None:
                break
            clique.add(best)
            candidates &= set(adjacency.get(best, set()))
        max_clique_size = max(max_clique_size, len(clique))

    return max_clique_size


# ══════════════════════════════════════════════════════════════════════════════
# 3. BİPARTİT GRAF - DERS ↔ DERSLİK EŞLEŞTİRMESİ
# ══════════════════════════════════════════════════════════════════════════════

def build_bipartite_graph():
    """
    Bipartite Graf: Ders ↔ Derslik
    ================================
    Sol küme: Dersler
    Sağ küme: Derslikler
    Kenar: Dersliğin kapasitesi ≥ dersin öğrenci sayısı
    
    Bu graf üzerinde maximum matching ile her derse
    uygun bir derslik atanır.
    
    Returns:
        courses: Sol küme node'ları
        classrooms: Sağ küme node'ları
        edges: Geçerli eşleşmeler
        matching: Atanan eşleşmeler
    """
    db = get_db()

    # Derslerin öğrenci sayılarını hesapla
    course_student_counts = {}
    rows = db.execute("""
        SELECT course_id, COUNT(*) as cnt FROM enrollments GROUP BY course_id
    """).fetchall()
    for row in rows:
        course_student_counts[row['course_id']] = row['cnt']

    # Dersler
    courses = db.execute("""
        SELECT c.id, c.code, c.name, c.class_level,
               ca.instructor_id, ca.classroom_id
        FROM courses c
        LEFT JOIN course_assignments ca ON c.id = ca.course_id
    """).fetchall()

    # Derslikler
    classrooms = db.execute("SELECT id, name, capacity FROM classrooms").fetchall()

    course_nodes = []
    for row in courses:
        student_count = course_student_counts.get(row['id'], 0)
        course_nodes.append({
            'id': row['id'],
            'code': row['code'],
            'name': row['name'],
            'class_level': row['class_level'],
            'student_count': student_count,
            'assigned_classroom': row['classroom_id']
        })

    classroom_nodes = []
    for row in classrooms:
        classroom_nodes.append({
            'id': row['id'],
            'name': row['name'],
            'capacity': row['capacity']
        })

    # Kenarlar: ders öğrenci sayısı ≤ derslik kapasitesi
    edges = []
    for c in course_nodes:
        for cl in classroom_nodes:
            if cl['capacity'] >= c['student_count']:
                is_assigned = (c['assigned_classroom'] == cl['id'])
                edges.append({
                    'course_id': c['id'],
                    'classroom_id': cl['id'],
                    'is_assigned': is_assigned,
                    'is_over_capacity': False
                })
            else:
                # Kapasite yetersiz - kırmızı kenar
                edges.append({
                    'course_id': c['id'],
                    'classroom_id': cl['id'],
                    'is_assigned': False,
                    'is_over_capacity': True
                })

    # Mevcut atamalar (matching)
    matching = {}
    for c in course_nodes:
        if c['assigned_classroom']:
            matching[c['id']] = c['assigned_classroom']

    db.close()
    return course_nodes, classroom_nodes, edges, matching


# ══════════════════════════════════════════════════════════════════════════════
# 4. KISIT KONTROLÜ
# ══════════════════════════════════════════════════════════════════════════════

def check_constraints(selected_course_ids, student_id=None):
    """
    Kısıt kontrolü yap ve ihlalleri döndür.
    
    Kısıtlar:
    1. AKTS limiti (max 30)
    2. Sınıf seviyesi (üst sınıf dersi alamaz)
    3. Hoca çakışması
    4. Derslik kapasitesi
    5. Derslik çakışması
    """
    db = get_db()
    violations = []
    warnings = []

    if not selected_course_ids:
        db.close()
        return violations, warnings

    # Seçili derslerin detayları
    placeholders = ','.join('?' * len(selected_course_ids))
    courses = db.execute(f"""
        SELECT c.id, c.code, c.name, c.akts, c.class_level,
               ca.instructor_id, ca.classroom_id,
               i.name as instructor_name,
               cl.capacity, cl.name as classroom_name
        FROM courses c
        LEFT JOIN course_assignments ca ON c.id = ca.course_id
        LEFT JOIN instructors i ON ca.instructor_id = i.id
        LEFT JOIN classrooms cl ON ca.classroom_id = cl.id
        WHERE c.id IN ({placeholders})
    """, selected_course_ids).fetchall()

    # 1. AKTS Kontrolü
    total_akts = sum(c['akts'] for c in courses)
    if total_akts > 30:
        violations.append({
            'type': 'akts',
            'severity': 'error',
            'message': f'AKTS sınırı aşıldı: {total_akts}/30'
        })

    # 2. Sınıf seviyesi kontrolü
    if student_id:
        student = db.execute(
            "SELECT class_level FROM students WHERE id = ?", (student_id,)
        ).fetchone()
        if student:
            for c in courses:
                if c['class_level'] > student['class_level']:
                    violations.append({
                        'type': 'class_level',
                        'severity': 'error',
                        'message': f'{c["code"]}: Üst sınıf dersi alınamaz (Ders: {c["class_level"]}. sınıf)'
                    })

    # 3. Hoca çakışması - aynı hoca birden fazla seçili derse atanmış
    instructor_courses = defaultdict(list)
    for c in courses:
        if c['instructor_id']:
            instructor_courses[c['instructor_id']].append(c['code'])
        else:
            warnings.append({
                'type': 'no_instructor',
                'severity': 'warning',
                'message': f'{c["code"]}: Hoca atanmadı'
            })

    for iid, codes in instructor_courses.items():
        if len(codes) > 1:
            violations.append({
                'type': 'instructor_conflict',
                'severity': 'error',
                'message': f'Hoca çakışması: {", ".join(codes)}'
            })

    # 4. Derslik kapasitesi kontrolü
    for c in courses:
        if c['classroom_id'] and c['capacity']:
            student_count = db.execute(
                "SELECT COUNT(*) FROM enrollments WHERE course_id = ?", (c['id'],)
            ).fetchone()[0]
            if student_count > c['capacity']:
                warnings.append({
                    'type': 'capacity',
                    'severity': 'warning',
                    'message': f'{c["code"]}: Kapasite yetersiz ({student_count}/{c["capacity"]})'
                })

    db.close()
    return violations, warnings


# ══════════════════════════════════════════════════════════════════════════════
# 5. PROGRAM OLUŞTURMA
# ══════════════════════════════════════════════════════════════════════════════

def generate_schedule(algorithm='dsatur', mode='ders'):
    """
    Tam program oluştur.
    
    1. Çakışma grafını oluştur
    2. Seçilen algoritmayı uygula
    3. Zaman slotlarını ata
    4. Program gridini döndür
    
    Ders Programı: Günlük grid (Pazartesi-Cuma, 09:00-18:00)
    Sınav Programı: Oturumlar halinde
    """
    nodes, edges, adjacency = build_conflict_graph(mode)

    if not nodes:
        return {}, [], {}, [], 0, 0

    # Renklendirme algoritması seç
    if algorithm == 'dsatur':
        coloring, steps = dsatur_coloring(nodes, adjacency)
    else:
        coloring, steps = greedy_coloring(nodes, adjacency)

    # Renkleri node'lara ata
    for node_id, color_idx in coloring.items():
        nodes[node_id]['color_index'] = color_idx

    chromatic_number = max(coloring.values()) + 1 if coloring else 0
    lower_bound = compute_chromatic_lower_bound(nodes, adjacency)

    # Zaman slotları (Ders programı için)
    if mode == 'ders':
        time_slots = _generate_course_time_slots(coloring, chromatic_number)
    else:
        time_slots = _generate_exam_time_slots(coloring, chromatic_number)

    # DB'ye kaydet - renk/slot bilgilerini güncelle
    db = get_db()
    for node_id, color_idx in coloring.items():
        db.execute(
            "UPDATE course_assignments SET time_slot = ? WHERE course_id = ?",
            (color_idx, node_id)
        )
    db.commit()
    db.close()

    return nodes, edges, adjacency, steps, chromatic_number, lower_bound


def _generate_course_time_slots(coloring, num_slots):
    """Renk → Gün/Saat eşleşmesi oluştur (Ders programı)"""
    days = ['Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma']
    hours = ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00']

    slots = {}
    slot_idx = 0
    for day in days:
        for hour in hours:
            if slot_idx >= num_slots:
                break
            slots[slot_idx] = {'day': day, 'hour': hour, 'label': f'{day} {hour}'}
            slot_idx += 1
        if slot_idx >= num_slots:
            break
    return slots


def _generate_exam_time_slots(coloring, num_slots):
    """Renk → Sınav oturumu eşleşmesi oluştur"""
    sessions = []
    for i in range(num_slots):
        day = i // 2 + 1
        session = 'Sabah (09:00-12:00)' if i % 2 == 0 else 'Öğleden Sonra (14:00-17:00)'
        sessions.append({'day': f'Gün {day}', 'session': session,
                         'label': f'Gün {day} - {session}'})
    return {i: sessions[i] for i in range(len(sessions))}
