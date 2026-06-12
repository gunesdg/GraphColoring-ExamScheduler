"""
Ders ve Sınav Çizelgeleme Sistemi - Ana Uygulama
Graf Teorisi tabanlı: Graph Coloring + Bipartite Matching
"""

from flask import Flask
from models.database import init_db
from routes.api import api_bp
from routes.main import main_bp

app = Flask(__name__)
app.config['SECRET_KEY'] = 'cizelgeleme-secret-key-2024'

# Blueprint'leri kaydet
app.register_blueprint(main_bp)
app.register_blueprint(api_bp, url_prefix='/api')

if __name__ == '__main__':
    # Veritabanını başlat ve örnek verileri yükle
    init_db()
    app.run(debug=True, port=5000)
