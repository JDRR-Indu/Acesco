# Acesco
# Detección Modular con IA

Este proyecto es una aplicación web para la detección inteligente en tiempo real con módulos de seguridad industrial:
- Áreas Restringidas
- EPPs (Equipos de Protección Personal)
- Temperatura
- Acciones Inseguras (simulado)

## 📦 Requisitos
Instala las dependencias con:

```bash
pip install -r requirements.txt
```

## 🚀 Ejecución
```bash
cd app
python app.py
```

Abre en tu navegador: [http://localhost:5000](http://localhost:5000)

## 🗂️ Estructura del Proyecto
```
deteccion_ia_modular/
├── app/
│   ├── app.py
│   ├── templates/index.html
│   └── static/
│       ├── css/styles.css
│       └── js/script.js
├── videos/              # Grabaciones generadas
├── areas/               # Archivos JSON cifrados con áreas
├── config/              # Configuración por cámara cifrada
├── requirements.txt
├── .gitignore
└── README.md
```

## 🔐 Seguridad
- Cifrado de archivos con `cryptography`
- Autenticación con sesiones cifradas
- Registro de auditoría (`audit.log`)
