# Ders & Sınav Çizelgeleme Sistemi

Graf teorisi tabanlı üniversite ders ve sınav programı oluşturma sistemi.

## Özellikler

- **Graph Coloring** (Greedy + DSATUR) ile çakışmasız zaman slotu atama
- **Bipartite Matching** ile derslik kapasitesi kısıtlı eşleştirme
- **D3.js** ile interaktif graf görselleştirme
- **Simülasyon modu** ile adım adım renklendirme animasyonu
- Ders Programı + Sınav Programı modları
- AKTS kısıtı, hoca/öğrenci/derslik çakışma kontrolü

## Kurulum

```bash
cd cizelgeleme
pip install flask --break-system-packages
python app.py
```

Tarayıcıda: http://localhost:5000

## Kullanım

1. **Program Oluştur** → Graf renklendirme çalışır, program oluşturulur
2. **Öğrenci Seç** → Kişiye özel alt graf görünümü
3. **Simülasyon Başlat** → Adım adım renklendirme izle
4. Tab'lar: Çakışma Grafı / Bipartit Graf / Öğrenciye Özel

## Matematiksel Model

- **V** = Dersler kümesi (nodes)
- **E** = Çakışma kenarları (ortak öğrenci / hoca / derslik)
- **χ(G)** = Kroma tik sayı = Minimum zaman slotu
- **DSATUR** = Saturation degree öncelikli renklendirme
