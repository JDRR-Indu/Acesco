from flask import Flask, Response, request, jsonify, render_template, send_from_directory
import cv2
import threading
import torch
import time
import os
from datetime import datetime
from cryptography.fernet import Fernet
import json
import logging
import functools

app = Flask(__name__, template_folder='templates', static_folder='static')

# Configuración de logging
logging.basicConfig(filename='audit.log', level=logging.INFO, 
                    format='%(asctime)s - %(levelname)s - %(message)s')

# Clave para cifrado
key_file = 'encryption_key.key'
if not os.path.exists(key_file):
    key = Fernet.generate_key()
    with open(key_file, 'wb') as f:
        f.write(key)
else:
    with open(key_file, 'rb') as f:
        key = f.read()
cipher = Fernet(key)

# Directorios
VIDEO_DIR = r"videos"
AREA_DIR = "areas"
CONFIG_DIR = "config"
os.makedirs(VIDEO_DIR, exist_ok=True)
os.makedirs(AREA_DIR, exist_ok=True)
os.makedirs(CONFIG_DIR, exist_ok=True)

# Cámaras
cameras = {
    1: "rtsp://Administrador:Indutronica2025@192.168.0.44:554/stream1",
    #1: "rtsp://admin:acesc02oi8@192.168.0.65:554/Streaming/Channels/101",
    #2:"rtsp://admin:acesc02oi8@192.168.0.65:554/Streaming/Channels/202"
}
MAX_CAMERAS = 4

# Usuarios y roles
users = {
    "admin": {"password": cipher.encrypt("admin123".encode()).decode(), "role": "Admin"},
    "supervisor": {"password": cipher.encrypt("super123".encode()).decode(), "role": "Supervisor"},
}

model = None
model_loaded = False
sessions = {}

def load_model():
    global model, model_loaded
    try:
        # Cargar el modelo YOLOv5 con un tamaño medio para mayor precisión
        model = torch.hub.load('ultralytics/yolov5', 'yolov5s.pt', pretrained=True)
        model.conf = 0.25  # Umbral de confianza más bajo para mayor sensibilidad
        model.iou = 0.45
        model.eval()
        model_loaded = True
        logging.info("Modelo YOLOv5 cargado correctamente")
        logging.info(f"Clases disponibles en el modelo: {model.names}")
    except Exception as e:
        logging.error(f"Error al cargar el modelo YOLO: {e}")
        model_loaded = False

class VideoStream:
    def __init__(self, url):
        self.url = url
        self.frame = None
        self.last_valid_frame = None
        self.lock = threading.Lock()
        self.running = True
        self.recording = False
        self.video_writer = None
        self.detection_start_time = None
        self.active_module = None
        self.use_model = False
        self.rectangles = []
        self.current_area = 1
        self.person_in_area = {1: False, 2: False}
        self.config = {}
        self.detections = {}
        self.reconnect_attempts = 0

        # Mapa para renombrar clases de YOLOv5 a nombres en español
        self.class_mapping = {
            'persona': 'Persona',
            'casco': 'Casco',
            'gafas': 'Gafas',
            'mask': 'Tapabocas',
            'protector auditivo': 'Protector auditivo',
            'guantes': 'Guantes',
            'botas': 'Botas',
            'laminadora': 'Laminadora'
        }

        self.cap = cv2.VideoCapture(self.url)
        if not self.cap.isOpened():
            raise RuntimeError(f"No se pudo abrir la cámara {self.url}")
        self.cap.set(cv2.CAP_PROP_BUFFERSIZE, 2)
        self.cap.set(cv2.CAP_PROP_FPS, 20)

        self.thread = threading.Thread(target=self.update, daemon=True)
        self.thread.start()

    def reconnect(self):
        self.reconnect_attempts += 1
        delay = min(1 + self.reconnect_attempts, 5)
        logging.info(f"Reintentando conexión a {self.url} tras {delay}s (intento {self.reconnect_attempts})")
        self.cap.release()
        time.sleep(delay)
        self.cap = cv2.VideoCapture(self.url)
        if self.cap.isOpened():
            self.reconnect_attempts = 0
            logging.info(f"Reconexión exitosa a {self.url}")
            return True
        return False

    def update(self):
        while self.running:
            ret, frame = self.cap.read()
            if not ret:
                logging.warning(f"Error al leer frame de {self.url}")
                if not self.reconnect():
                    continue
                ret, frame = self.cap.read()
                if not ret:
                    continue
            with self.lock:
                self.frame = frame
                self.last_valid_frame = frame.copy()
            if self.recording and self.video_writer:
                self.video_writer.write(frame)

    def process_frame(self, frame):
        if not self.use_model or self.active_module == "Temperatura":
            return frame
        frame_resized = cv2.resize(frame, (640, 480))
        frame_rgb = cv2.cvtColor(frame_resized, cv2.COLOR_BGR2RGB)
        results = model(frame_rgb)
        rendered_frame = frame_resized.copy()

        # Inicializar las detecciones con todas las clases en False
        self.detections = {cls: False for cls in ['Casco', 'Gafas', 'Tapabocas', 'Protector auditivo', 'Guantes', 'Botas', 'Laminadora', 'Persona']}
        detections_to_render = []

        # Log para verificar las detecciones crudas del modelo
        logging.info(f"Detecciones crudas: {results.xyxy[0]}")

        for *xyxy, conf, cls in results.xyxy[0]:
            cls_name = model.names[int(cls)]  # Nombre en inglés (e.g., "person")
            # Mapear el nombre en inglés al nombre en español
            mapped_cls_name = self.class_mapping.get(cls_name, cls_name)
            if mapped_cls_name in self.detections:
                self.detections[mapped_cls_name] = True
                logging.info(f"Detectado: {mapped_cls_name} con confianza {conf}")
                if self.active_module == "EPP's":
                    config_key = f"config-{mapped_cls_name.lower().replace(' ', '-')}"
                    if self.config.get(config_key, False):
                        detections_to_render.append((*xyxy, conf, cls))
                elif self.active_module == "Áreas Restringidas":
                    config_key_1 = f"detect-{mapped_cls_name.lower().replace(' ', '-')}-1"
                    config_key_2 = f"detect-{mapped_cls_name.lower().replace(' ', '-')}-2"
                    if self.config.get(config_key_1, False) or self.config.get(config_key_2, False):
                        detections_to_render.append((*xyxy, conf, cls))

        # Renderizar las detecciones
        for x1, y1, x2, y2, conf, cls in detections_to_render:
            cls_name = model.names[int(cls)]
            mapped_cls_name = self.class_mapping.get(cls_name, cls_name)
            cv2.rectangle(rendered_frame, (int(x1), int(y1)), (int(x2), int(y2)), (0, 255, 0), 2)
            cv2.putText(rendered_frame, f"{mapped_cls_name} {conf:.2f}", (int(x1), int(y1) - 10),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 2)

        if self.active_module == "Áreas Restringidas":
            for x1, y1, x2, y2, area_type in self.rectangles:
                color = (0, 255, 0) if area_type == 1 else (0, 0, 255)
                cv2.rectangle(rendered_frame, (x1, y1), (x2, y2), color, 2)
                cv2.putText(rendered_frame, f"Área {area_type}", (x1, y1 - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 2)

            self.person_in_area = {1: False, 2: False}
            should_record = False
            for *xyxy, conf, cls in results.xyxy[0]:
                cls_name = model.names[int(cls)]
                mapped_cls_name = self.class_mapping.get(cls_name, cls_name)
                if mapped_cls_name in self.detections:
                    x1, y1, x2, y2 = map(int, xyxy)
                    obj_center = ((x1 + x2) // 2, (y1 + y2) // 2)
                    logging.info(f"Centro del objeto {mapped_cls_name}: {obj_center}")
                    for rect in self.rectangles:
                        logging.info(f"Área {rect[4]}: x1={rect[0]}, y1={rect[1]}, x2={rect[2]}, y2={rect[3]}")
                        if rect[0] < obj_center[0] < rect[2] and rect[1] < obj_center[1] < rect[3]:
                            area_id = rect[4]
                            config_key = f"detect-{mapped_cls_name.lower().replace(' ', '-')}-{area_id}"
                            if self.config.get(config_key, False):
                                self.person_in_area[area_id] = True
                                should_record = True
                                logging.info(f"Persona detectada en Área {area_id}")
                            break

            if should_record and not self.recording and self.detection_start_time is None:
                self.detection_start_time = time.time()
            elif should_record and self.detection_start_time and time.time() - self.detection_start_time > 2:
                self.start_recording()
            elif not should_record and self.detection_start_time:
                self.stop_recording()
                self.detection_start_time = None

        return rendered_frame

    def start_recording(self):
        if not self.recording:
            self.recording = True
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            filename = os.path.join(VIDEO_DIR, f"event_{timestamp}.mp4")
            self.video_writer = cv2.VideoWriter(filename, cv2.VideoWriter_fourcc(*'H264'), 20, (640, 480))
            logging.info(f"Grabación iniciada: {filename}")

    def stop_recording(self):
        if self.recording:
            self.recording = False
            if self.video_writer:
                self.video_writer.release()
                self.video_writer = None
                logging.info("Grabación detenida")

    def get_processed_frame(self):
        with self.lock:
            if self.frame is None and self.last_valid_frame is not None:
                return self.process_frame(self.last_valid_frame.copy())
            if self.frame is None:
                return None
            return self.process_frame(self.frame.copy())

    def add_rectangle(self, x1, y1, x2, y2):
        x1, y1 = int(min(x1, x2)), int(min(y1, y2))
        x2, y2 = int(max(x1, x2)), int(max(y1, y2))
        existing_area = next((r for r in self.rectangles if r[4] == self.current_area), None)
        if existing_area:
            self.rectangles = [(x1, y1, x2, y2, self.current_area) if r[4] == self.current_area else r for r in self.rectangles]
        else:
            self.rectangles.append((x1, y1, x2, y2, self.current_area))
        logging.info(f"Área añadida: x1={x1}, y1={y1}, x2={x2}, y2={y2}, area={self.current_area}")

    def delete_area(self, area_type):
        self.rectangles = [r for r in self.rectangles if r[4] != area_type]
        logging.info(f"Área eliminada: {area_type}")

    def delete_all(self):
        self.rectangles.clear()
        logging.info("Todas las áreas eliminadas")

    def set_current_area(self, area):
        self.current_area = area
        logging.info(f"Área actual establecida: {area}")

    def set_module_active(self, active, module=None):
        self.use_model = active and module != "Temperatura"
        self.active_module = module if active else None
        if not active:
            self.delete_all()
            self.config.clear()
        logging.info(f"Módulo {module} {'activado' if active else 'desactivado'}")

    def update_config(self, config):
        self.config = config
        logging.info(f"Configuración actualizada: {config}")

    def __del__(self):
        self.running = False
        if self.cap.isOpened():
            self.cap.release()
        if self.video_writer:
            self.video_writer.release()

video_streams = {}
for cam_id, url in cameras.items():
    try:
        video_streams[cam_id] = VideoStream(url)
        logging.info(f"Cámara {cam_id} inicializada correctamente")
    except Exception as e:
        logging.error(f"Error al inicializar cámara {cam_id}: {e}")

def generate_frames(camera_id):
    stream = video_streams.get(camera_id)
    if not stream:
        return
    while True:
        try:
            frame = stream.get_processed_frame()
            if frame is None:
                time.sleep(0.1)
                continue
            ret, buffer = cv2.imencode('.jpg', frame, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
            if not ret:
                continue
            yield (b'--frame\r\n'
                   b'Content-Type: image/jpeg\r\n\r\n' + buffer.tobytes() + b'\r\n')
        except Exception as e:
            logging.error(f"Error en generación de frames: {e}")
            time.sleep(1)

# Autenticación
def check_auth(role_required):
    def decorator(f):
        @functools.wraps(f)
        def wrapper(*args, **kwargs):
            session_id = request.headers.get('Authorization')
            if session_id in sessions and sessions[session_id]['role'] in role_required:
                return f(*args, **kwargs)
            logging.warning(f"Acceso denegado: rol insuficiente para {session_id}")
            return jsonify({"status": "error", "message": "Acceso denegado"}), 403
        return wrapper
    return decorator

@app.route('/login', methods=['POST'])
def login():
    data = request.get_json()
    username = data.get('username')
    password = data.get('password')
    if username in users:
        try:
            decrypted_password = cipher.decrypt(users[username]['password'].encode()).decode()
            if password == decrypted_password:
                session_id = os.urandom(16).hex()
                sessions[session_id] = {"username": username, "role": users[username]['role']}
                logging.info(f"Usuario {username} ({users[username]['role']}) inició sesión")
                return jsonify({"status": "success", "session_id": session_id, "role": users[username]['role']})
        except Exception as e:
            logging.error(f"Error al desencriptar contraseña para {username}: {e}")
    logging.warning(f"Intento de login fallido para {username}")
    return jsonify({"status": "error", "message": "Credenciales incorrectas"}), 401

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/video_feed')
def video_feed():
    camera_id = int(request.args.get('camera', 1))
    return Response(generate_frames(camera_id), mimetype='multipart/x-mixed-replace; boundary=frame')

@app.route('/set_module', methods=['POST'])
@check_auth(["Admin", "Supervisor"])
def set_module():
    data = request.get_json()
    module = data.get('module')
    camera_id = data.get('camera_id', 1)
    active = data.get('active', False)
    if camera_id in video_streams:
        video_streams[camera_id].set_module_active(active, module)
        return jsonify({"status": "success", "model_active": video_streams[camera_id].use_model})
    return jsonify({"status": "error", "message": "Camera not found"}), 404

@app.route('/add_rectangle', methods=['POST'])
@check_auth(["Admin"])
def add_rectangle():
    data = request.get_json()
    camera_id = data.get('camera_id', 1)
    x1, y1, x2, y2 = data['x1'], data['y1'], data['x2'], data['y2']
    if camera_id in video_streams:
        video_streams[camera_id].add_rectangle(x1, y1, x2, y2)
        return jsonify({"status": "success"})
    return jsonify({"status": "error", "message": "Camera not found"}), 404

@app.route('/delete_area', methods=['POST'])
@check_auth(["Admin"])
def delete_area():
    data = request.get_json()
    camera_id = data.get('camera_id', 1)
    area_type = data.get('area_type')
    if camera_id in video_streams:
        video_streams[camera_id].delete_area(area_type)
        return jsonify({"status": "success"})
    return jsonify({"status": "error", "message": "Camera not found"}), 404

@app.route('/delete_all_areas', methods=['POST'])
@check_auth(["Admin"])
def delete_all_areas():
    data = request.get_json()
    camera_id = data.get('camera_id', 1)
    if camera_id in video_streams:
        video_streams[camera_id].delete_all()
        return jsonify({"status": "success"})
    return jsonify({"status": "error", "message": "Camera not found"}), 404

@app.route('/set_current_area', methods=['POST'])
@check_auth(["Admin"])
def set_current_area():
    data = request.get_json()
    camera_id = data.get('camera_id', 1)
    area = data.get('area')
    if camera_id in video_streams:
        video_streams[camera_id].set_current_area(area)
        return jsonify({"status": "success"})
    return jsonify({"status": "error", "message": "Camera not found"}), 404

@app.route('/add_camera', methods=['POST'])
@check_auth(["Admin"])
def add_camera():
    data = request.get_json()
    camera_id = data.get('camera_id')
    url = data.get('url')
    if camera_id in cameras:
        return jsonify({"status": "error", "message": "Camera ID already exists"}), 400
    if len(cameras) >= MAX_CAMERAS:
        return jsonify({"status": "error", "message": "Maximum number of cameras reached"}), 400
    try:
        video_streams[camera_id] = VideoStream(url)
        cameras[camera_id] = url
        logging.info(f"Cámara {camera_id} añadida")
        return jsonify({"status": "success"})
    except Exception as e:
        logging.error(f"Error al añadir cámara {camera_id}: {e}")
        return jsonify({"status": "error", "message": str(e)}), 500

@app.route('/delete_camera', methods=['POST'])
@check_auth(["Admin"])
def delete_camera():
    data = request.get_json()
    camera_id = data.get('camera_id')
    if camera_id in video_streams:
        del video_streams[camera_id]
        del cameras[camera_id]
        logging.info(f"Cámara {camera_id} eliminada")
        return jsonify({"status": "success"})
    return jsonify({"status": "error", "message": "Camera not found"}), 404

@app.route('/save_areas', methods=['POST'])
@check_auth(["Admin"])
def save_areas():
    data = request.get_json()
    camera_id = data.get('camera_id', 1)
    if camera_id in video_streams:
        filename = os.path.join(AREA_DIR, f"areas_cam{camera_id}.json")
        try:
            areas = [{"x1": x1, "y1": y1, "x2": x2, "y2": y2, "area_type": area_type}
                     for x1, y1, x2, y2, area_type in video_streams[camera_id].rectangles]
            encrypted_data = cipher.encrypt(json.dumps(areas).encode())
            with open(filename, 'wb') as f:
                f.write(encrypted_data)
            logging.info(f"Áreas guardadas para cámara {camera_id}")
            return jsonify({"status": "success"})
        except Exception as e:
            logging.error(f"Error al guardar áreas: {e}")
            return jsonify({"status": "error", "message": str(e)}), 500
    return jsonify({"status": "error", "message": "Camera not found"}), 404

@app.route('/load_areas')
@check_auth(["Admin", "Supervisor"])
def load_areas():
    camera_id = int(request.args.get('camera', 1))
    if camera_id in video_streams:
        filename = os.path.join(AREA_DIR, f"areas_cam{camera_id}.json")
        areas = []
        try:
            if os.path.exists(filename):
                with open(filename, 'rb') as f:
                    encrypted_data = f.read()
                decrypted_data = cipher.decrypt(encrypted_data).decode()
                areas = json.loads(decrypted_data)
            return jsonify({"status": "success", "areas": areas})
        except Exception as e:
            logging.error(f"Error al cargar áreas: {e}")
            return jsonify({"status": "error", "message": str(e)}), 500
    return jsonify({"status": "error", "message": "Camera not found"}), 404

@app.route('/upload_areas', methods=['POST'])
@check_auth(["Admin"])
def upload_areas():
    camera_id = int(request.form.get('camera_id', 1))
    if 'file' not in request.files:
        return jsonify({"status": "error", "message": "No file provided"}), 400
    file = request.files['file']
    if file.filename == '':
        return jsonify({"status": "error", "message": "No file selected"}), 400
    if camera_id in video_streams:
        try:
            encrypted_data = file.read()
            decrypted_data = cipher.decrypt(encrypted_data).decode()
            areas = json.loads(decrypted_data)
            video_streams[camera_id].rectangles = [
                (area['x1'], area['y1'], area['x2'], area['y2'], area['area_type'])
                for area in areas
            ]
            logging.info(f"Áreas cargadas desde archivo para cámara {camera_id}")
            return jsonify({"status": "success", "areas": areas})
        except Exception as e:
            logging.error(f"Error al cargar áreas desde archivo: {e}")
            return jsonify({"status": "error", "message": str(e)}), 500
    return jsonify({"status": "error", "message": "Camera not found"}), 404

@app.route('/videos')
@check_auth(["Admin", "Supervisor"])
def list_videos():
    try:
        videos = [f for f in os.listdir(VIDEO_DIR) if f.endswith('.mp4')]
        return jsonify({"status": "success", "videos": videos})
    except Exception as e:
        logging.error(f"Error al listar videos: {e}")
        return jsonify({"status": "error", "message": str(e)}), 500

@app.route('/videos/<filename>')
@check_auth(["Admin", "Supervisor"])
def serve_video(filename):
    return send_from_directory(VIDEO_DIR, filename)

@app.route('/person_in_area')
@check_auth(["Admin", "Supervisor"])
def person_in_area():
    camera_id = int(request.args.get('camera', 1))
    if camera_id in video_streams:
        return jsonify({"status": "success", "person_in_area": video_streams[camera_id].person_in_area})
    return jsonify({"status": "error", "message": "Camera not found"}), 404

@app.route('/detections')
@check_auth(["Admin", "Supervisor"])
def detections():
    camera_id = int(request.args.get('camera', 1))
    module = request.args.get('module')
    if camera_id in video_streams:
        stream = video_streams[camera_id]
        return jsonify({"status": "success", "detections": stream.detections, "person_in_area": stream.person_in_area})
    return jsonify({"status": "error", "message": "Camera not found"}), 404

@app.route('/update_config', methods=['POST'])
@check_auth(["Admin"])
def update_config():
    data = request.get_json()
    camera_id = data.get('camera_id', 1)
    config = data.get('config', {})
    if camera_id in video_streams:
        video_streams[camera_id].update_config(config)
        filename = os.path.join(CONFIG_DIR, f"config_cam{camera_id}.json")
        try:
            encrypted_data = cipher.encrypt(json.dumps(config).encode())
            with open(filename, 'wb') as f:
                f.write(encrypted_data)
            logging.info(f"Configuración guardada para cámara {camera_id}")
            return jsonify({"status": "success"})
        except Exception as e:
            logging.error(f"Error al guardar configuración: {e}")
            return jsonify({"status": "error", "message": str(e)}), 500
    return jsonify({"status": "error", "message": "Camera not found"}), 404

if __name__ == '__main__':
    load_model()
    app.run(host='0.0.0.0', port=5000, debug=False, threaded=True)