from app import app
from models.database import init_db
init_db()
app.run(host='0.0.0.0', port=5000, debug=False, use_reloader=False)
