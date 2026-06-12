"""
Veritabanı Modeli - OBS Mantığı
enrollment.status: 'enrolled' | 'failed' | 'passed'
courses.is_mandatory: 1=zorunlu, 0=seçmeli
"""
import sqlite3, os

DB_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'cizelgeleme.db')


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    conn = get_db()
    c = conn.cursor()

    c.execute('''CREATE TABLE IF NOT EXISTS students (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        class_level INTEGER NOT NULL CHECK(class_level BETWEEN 1 AND 4)
    )''')

    c.execute('''CREATE TABLE IF NOT EXISTS courses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        akts INTEGER NOT NULL DEFAULT 3,
        class_level INTEGER NOT NULL CHECK(class_level BETWEEN 1 AND 4),
        is_mandatory INTEGER NOT NULL DEFAULT 1
    )''')

    c.execute('''CREATE TABLE IF NOT EXISTS instructors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL
    )''')

    c.execute('''CREATE TABLE IF NOT EXISTS classrooms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        capacity INTEGER NOT NULL
    )''')

    c.execute('''CREATE TABLE IF NOT EXISTS enrollments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id INTEGER NOT NULL,
        course_id INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'enrolled',
        FOREIGN KEY(student_id) REFERENCES students(id),
        FOREIGN KEY(course_id) REFERENCES courses(id),
        UNIQUE(student_id, course_id)
    )''')

    c.execute('''CREATE TABLE IF NOT EXISTS course_assignments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        course_id INTEGER NOT NULL UNIQUE,
        instructor_id INTEGER,
        classroom_id INTEGER,
        time_slot INTEGER DEFAULT NULL,
        day_slot INTEGER DEFAULT NULL,
        FOREIGN KEY(course_id) REFERENCES courses(id),
        FOREIGN KEY(instructor_id) REFERENCES instructors(id),
        FOREIGN KEY(classroom_id) REFERENCES classrooms(id)
    )''')

    conn.commit()

    if c.execute("SELECT COUNT(*) FROM students").fetchone()[0] == 0:
        _seed(c)
        conn.commit()

    conn.close()
    print("✅ DB hazır:", DB_PATH)


def _seed(c):
    students = [
        ('Ali Yılmaz', 2), ('Ayşe Kara', 1), ('Mehmet Demir', 1),
        ('Fatma Çelik', 2), ('Hasan Öztürk', 3), ('Zeynep Arslan', 2),
        ('Murat Şahin', 3), ('Elif Güneş', 3), ('Can Yıldız', 4),
        ('Selin Doğan', 4), ('Burak Aydın', 2), ('Deniz Koç', 1),
        ('Emre Kurt', 2), ('Gizem Polat', 3), ('Okan Taş', 1),
    ]
    c.executemany("INSERT INTO students(name,class_level) VALUES(?,?)", students)

    courses = [
        ('MAT101','Matematik I',        6,1,1),
        ('FIZ101','Fizik I',            6,1,1),
        ('KIM101','Kimya I',            5,1,1),
        ('BIL101','Programlamaya Giriş',4,1,1),
        ('ING101','İngilizce I',        3,1,1),
        ('MAT201','Matematik II',       6,2,1),
        ('FIZ201','Fizik II',           6,2,1),
        ('VER201','Veri Yapıları',      5,2,1),
        ('ALG201','Algoritmalar',       5,2,1),
        ('ING201','İngilizce II',       3,2,1),
        ('MAT301','Diferansiyel Denk.', 5,3,1),
        ('YAP301','Yapay Zeka',         6,3,1),
        ('VER301','Veritabanı',         5,3,1),
        ('AGS301','Ağ Sistemleri',      4,3,1),
        ('MOB301','Mobil Programlama',  4,3,0),
        ('MAT401','Sayısal Analiz',     4,4,1),
        ('BIT401','Bitirme Projesi',    8,4,1),
        ('GUV401','Güvenlik',           5,4,1),
    ]
    c.executemany("INSERT INTO courses(code,name,akts,class_level,is_mandatory) VALUES(?,?,?,?,?)", courses)

    instructors = [
        ('Prof. Dr. Arslan',),('Dr. Demir',),('Prof. Dr. Kaya',),
        ('Doç. Dr. Yıldız',),('Dr. Çelik',),('Prof. Dr. Şahin',),
        ('Doç. Dr. Öztürk',),('Dr. Güneş',),
    ]
    c.executemany("INSERT INTO instructors(name) VALUES(?)", instructors)

    classrooms = [
        ('Derslik A-101',50),('Derslik A-102',80),('Derslik B-201',120),
        ('Amfi 1',200),('Lab-1',30),('Lab-2',30),
        ('Derslik C-301',60),('Derslik C-302',60),
    ]
    c.executemany("INSERT INTO classrooms(name,capacity) VALUES(?,?)", classrooms)

    assignments = [
        (1,1,4),(2,2,1),(3,3,1),(4,4,5),(5,5,2),
        (6,1,4),(7,2,1),(8,4,5),(9,4,2),(10,5,2),
        (11,6,2),(12,6,4),(13,7,3),(14,8,2),(15,3,5),
        (16,3,2),(17,1,4),(18,8,3),
    ]
    c.executemany(
        "INSERT INTO course_assignments(course_id,instructor_id,classroom_id) VALUES(?,?,?)",
        assignments
    )

    # Ali(1,sınıf=2): MAT101+KIM101 failed, 2.sınıf dersleri enrolled
    # Fatma(4,sınıf=2): ING101 failed
    # Hasan(5,sınıf=3): VER201 failed
    # Can(9,sınıf=4): MAT301 failed
    # Burak(11,sınıf=2): ALG201 failed
    enrollments = [
        (1,1,'failed'),(1,3,'failed'),(1,6,'enrolled'),(1,7,'enrolled'),(1,8,'enrolled'),
        (2,1,'enrolled'),(2,2,'enrolled'),(2,4,'enrolled'),(2,5,'enrolled'),
        (3,1,'enrolled'),(3,3,'enrolled'),(3,4,'enrolled'),(3,5,'enrolled'),
        (4,5,'failed'),(4,6,'enrolled'),(4,7,'enrolled'),(4,8,'enrolled'),(4,9,'enrolled'),
        (5,8,'failed'),(5,11,'enrolled'),(5,12,'enrolled'),(5,13,'enrolled'),
        (6,6,'enrolled'),(6,9,'enrolled'),(6,10,'enrolled'),
        (7,11,'enrolled'),(7,12,'enrolled'),(7,13,'enrolled'),
        (8,11,'enrolled'),(8,12,'enrolled'),(8,14,'enrolled'),
        (9,11,'failed'),(9,16,'enrolled'),(9,17,'enrolled'),(9,18,'enrolled'),
        (10,16,'enrolled'),(10,17,'enrolled'),(10,18,'enrolled'),
        (11,9,'failed'),(11,6,'enrolled'),(11,7,'enrolled'),(11,10,'enrolled'),
        (12,1,'enrolled'),(12,2,'enrolled'),(12,4,'enrolled'),
        (13,7,'enrolled'),(13,8,'enrolled'),(13,9,'enrolled'),
        (14,11,'enrolled'),(14,13,'enrolled'),(14,15,'enrolled'),
        (15,1,'enrolled'),(15,2,'enrolled'),(15,3,'enrolled'),
    ]
    c.executemany(
        "INSERT INTO enrollments(student_id,course_id,status) VALUES(?,?,?)",
        enrollments
    )
