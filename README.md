# 🗓️ Ders & Sınav Çizelgeleme Sistemi

Graf teorisi tabanlı, yapay zeka destekli üniversite ders ve sınav programı oluşturma sistemi.

## 🚀 Özellikler

* **Graph Coloring (Greedy + DSATUR):** Sıfır çakışmalı zaman slotu atama algoritması.
* **Bipartite Matching:** Derslik kapasitesi kısıtlı ve optimize edilmiş eşleştirme.
* **D3.js Görselleştirme:** Etkileşimli ve dinamik graf ağ yapısı.
* **Simülasyon Modu:** Adım adım graf renklendirme animasyonu.
* **Çift Mod Desteği:** Hem Dönem içi Ders Programı hem de Sınav Programı modları.
* **Gelişmiş Kısıt Yönetimi:** AKTS kısıtı, hoca/öğrenci/derslik çakışma kontrolleri.

---

## 🛠️ Kurulum

Uygulamayı yerel bilgisayarınızda çalıştırmak için aşağıdaki adımları takip edin:

```bash
# Proje dizinine geçiş yapın
cd cizelgeleme

# Gerekli kütüphaneleri yükleyin
pip install flask --break-system-packages

# Uygulamayı başlatın
python app.py
