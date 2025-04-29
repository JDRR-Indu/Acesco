// Variables globales
let selectedModule = null;
let isModuleActive = false;
let currentCamera = 1;
let isDrawing = false;
let startX, startY;
let lastVideoCount = 0;
let sessionId = null;
let userRole = null;
let username = null;

// Evento al cargar el DOM
document.addEventListener('DOMContentLoaded', () => {
    const loginButton = document.getElementById('login-button');
    loginButton.addEventListener('click', login);

    document.querySelectorAll('.module-buttons button').forEach(button => {
        button.addEventListener('click', () => onModuleClick(button.dataset.module));
    });

    const applyButton = document.querySelector('.module-actions .apply');
    const cancelButton = document.querySelector('.module-actions .cancel');
    applyButton.addEventListener('click', applyModule);
    cancelButton.addEventListener('click', cancelModule);

    document.querySelector('.clear-events').addEventListener('click', clearEvents);
    document.querySelectorAll('.player-tabs button[data-camera]').forEach(button => {
        button.addEventListener('click', () => onCameraClick(parseInt(button.dataset.camera)));
        button.addEventListener('contextmenu', (e) => onCameraRightClick(e, parseInt(button.dataset.camera)));
    });

    document.getElementById('add-camera').addEventListener('click', addNewCamera);

    const videoStream = document.getElementById('video-stream');
    videoStream.addEventListener('mousedown', onMousePress);
    videoStream.addEventListener('mousemove', onMouseMove);
    videoStream.addEventListener('mouseup', onMouseRelease);
    videoStream.addEventListener('contextmenu', onRightClick);

    window.addEventListener('resize', () => fetchAreas(currentCamera));
});

// Login
async function login() {
    const usernameInput = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    const errorP = document.getElementById('login-error');

    const res = await fetch('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: usernameInput, password })
    });
    const data = await res.json();

    if (data.status === 'success') {
        sessionId = data.session_id;
        userRole = data.role;
        username = usernameInput;
        document.getElementById('login-container').style.display = 'none';
        document.getElementById('main-container').style.display = 'block';
        document.getElementById('username-display').textContent = username;
        document.getElementById('role-display').textContent = userRole;
        resetToDefault();
        onCameraClick(1);
        fetchAreas(currentCamera);
        setInterval(checkForNewVideos, 5000);
        setInterval(updateDetections, 1000);
        restrictUIByRole();
    } else {
        errorP.textContent = data.message;
        errorP.style.display = 'block';
    }
}

// Restringir UI según rol
function restrictUIByRole() {
    if (userRole === 'Supervisor') {
        document.getElementById('add-camera').style.display = 'none';
        document.querySelector('.configurations').style.display = 'none';
    }
}

// Restablecer al estado predeterminado
function resetToDefault() {
    selectedModule = null;
    isModuleActive = false;
    updateModelStatus(false);
    document.querySelectorAll('.module-buttons button').forEach(btn => btn.classList.remove('active'));
    updateConfigPanel();
    updateDetectionsPanel();
    document.querySelectorAll('.area-overlay').forEach(area => area.remove());
    const applyButton = document.querySelector('.module-actions .apply');
    applyButton.textContent = 'Aplicar Módulo';
}

// Actualizar estado del modelo
function updateModelStatus(isModelActive) {
    const statusElement = document.getElementById('module-status');
    statusElement.textContent = isModelActive
        ? `Módulo activo: ${selectedModule} | Modelo: Activo`
        : 'Ningún módulo activo | Modelo: Inactivo';
    statusElement.style.color = isModelActive ? '#44ff44' : '#ff4444';
}

// Seleccionar un módulo
function onModuleClick(module) {
    if (userRole === 'Supervisor' && isModuleActive && selectedModule !== module) {
        addEvent(`Cancela el módulo activo (${selectedModule}) primero`, 1000);
        return;
    }
    selectedModule = module;
    document.querySelectorAll('.module-buttons button').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.module === module);
    });
    if (!isModuleActive) {
        updateConfigPanel();
        updateDetectionsPanel();
    }
}

// Actualizar panel de configuraciones
function updateConfigPanel() {
    const configList = document.getElementById('config-list');
    configList.innerHTML = '';
    const configTitle = document.getElementById('config-title');
    configTitle.textContent = selectedModule ? `Configuración de ${selectedModule}` : 'Configuraciones';

    if (!selectedModule || !isModuleActive || userRole !== 'Admin') return;

    let options = [];
    if (selectedModule === 'Acciones Inseguras') {
        options = ['Entró saltando', 'Se cayó', 'Pasó corriendo'];
    } else if (selectedModule === 'Temperatura') {
        options = ['Calor', 'Estable', 'Frío'];
    } else if (selectedModule === "EPP's") {
        options = ['Casco', 'Gafas', 'Tapabocas', 'Protector auditivo', 'Guantes', 'Botas', 'Laminadora', 'Persona'];
    } else if (selectedModule === 'Áreas Restringidas') {
        options = [
            { text: 'Área 1', action: () => setCurrentArea(1) },
            { text: 'Área 2', action: () => setCurrentArea(2) },
            { text: 'Borrar Área 1', action: () => deleteArea(1) },
            { text: 'Borrar Área 2', action: () => deleteArea(2) },
            { text: 'Borrar Todo', action: deleteAllAreas },
            { text: 'Guardar Áreas', action: saveAreas },
            { text: 'Cargar Áreas desde Archivo', action: loadAreasFromFile }
        ];
    }

    if (selectedModule === 'Áreas Restringidas') {
        options.forEach(({ text, action }) => {
            const li = document.createElement('li');
            const button = document.createElement('button');
            button.textContent = text;
            button.className = 'config-button';
            button.addEventListener('click', action);
            li.appendChild(button);
            configList.appendChild(li);
        });
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.id = 'area-file-input';
        fileInput.accept = '.json';
        fileInput.style.display = 'none';
        fileInput.addEventListener('change', handleFileSelect);
        configList.appendChild(fileInput);
    } else {
        options.forEach(opt => {
            const li = document.createElement('li');
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.id = `config-${opt.toLowerCase().replace(' ', '-')}`;
            checkbox.addEventListener('change', () => updateServerConfig());
            li.appendChild(checkbox);
            li.appendChild(document.createTextNode(` ${opt}`));
            configList.appendChild(li);
        });
    }
}

// Actualizar panel de detecciones
async function updateDetectionsPanel() {
    const detectionsList = document.getElementById('detections-list');
    detectionsList.innerHTML = '';

    if (!isModuleActive || !selectedModule) return;

    if (selectedModule === 'Áreas Restringidas') {
        const areas = ['Área 1', 'Área 2'];
        const subOptions = ['Casco', 'Gafas', 'Tapabocas', 'Protector auditivo', 'Guantes', 'Botas', 'Laminadora', 'Persona'];
        areas.forEach((area, index) => {
            const li = document.createElement('li');
            const details = document.createElement('details');
            const summary = document.createElement('summary');
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.id = `area${index + 1}`;
            checkbox.disabled = true;
            summary.appendChild(checkbox);
            summary.appendChild(document.createTextNode(` ${area}`));
            details.appendChild(summary);

            const ul = document.createElement('ul');
            subOptions.forEach(opt => {
                const subLi = document.createElement('li');
                const subCheckbox = document.createElement('input');
                subCheckbox.type = 'checkbox';
                subCheckbox.id = `detect-${opt.toLowerCase().replace(' ', '-')}-${index + 1}`;
                if (userRole === 'Admin') {
                    subCheckbox.addEventListener('change', () => updateServerConfig());
                } else {
                    subCheckbox.disabled = true;
                }
                subLi.appendChild(subCheckbox);
                subLi.appendChild(document.createTextNode(` ${opt}`));
                ul.appendChild(subLi);
            });
            details.appendChild(ul);
            li.appendChild(details);
            detectionsList.appendChild(li);
        });
    } else {
        let options = [];
        if (selectedModule === 'Acciones Inseguras') {
            options = ['Entró saltando', 'Se cayó', 'Pasó corriendo'];
        } else if (selectedModule === 'Temperatura') {
            options = ['Calor', 'Estable', 'Frío'];
        } else if (selectedModule === "EPP's") {
            options = ['Casco', 'Gafas', 'Tapabocas', 'Protector auditivo', 'Guantes', 'Botas', 'Laminadora', 'Persona'];
        }
        options.forEach(opt => {
            const li = document.createElement('li');
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.id = `detect-${opt.toLowerCase().replace(' ', '-')}`;
            checkbox.disabled = true;
            li.appendChild(checkbox);
            li.appendChild(document.createTextNode(` ${opt}`));
            detectionsList.appendChild(li);
        });
    }
    await updateDetections();
}

// Actualizar configuraciones en el servidor
async function updateServerConfig() {
    if (!isModuleActive || userRole !== 'Admin') return;
    const config = {};
    if (selectedModule === 'Áreas Restringidas') {
        ['Casco', 'Gafas', 'Tapabocas', 'Protector auditivo', 'Guantes', 'Botas', 'Laminadora', 'Persona'].forEach(opt => {
            const id1 = `detect-${opt.toLowerCase().replace(' ', '-')}-1`;
            const id2 = `detect-${opt.toLowerCase().replace(' ', '-')}-2`;
            config[id1] = document.getElementById(id1).checked;
            config[id2] = document.getElementById(id2).checked;
        });
    } else if (selectedModule === "EPP's") {
        document.querySelectorAll('#config-list input[type="checkbox"]').forEach(checkbox => {
            config[checkbox.id.replace('config-', '')] = checkbox.checked;
        });
    }
    await fetch('/update_config', {
        method: 'POST',
        headers: { 
            'Content-Type': 'application/json',
            'Authorization': sessionId
        },
        body: JSON.stringify({ camera_id: currentCamera, config })
    });
}

// Cambiar de cámara
function onCameraClick(cameraNumber) {
    if (isModuleActive && selectedModule === 'Temperatura' && cameraNumber !== 2) {
        addEvent('No se puede cambiar de cámara con el módulo Temperatura activo', 1000);
        return;
    }
    currentCamera = cameraNumber;
    document.querySelectorAll('.player-tabs button[data-camera]').forEach(btn => {
        btn.classList.toggle('active', parseInt(btn.dataset.camera) === cameraNumber);
    });
    document.getElementById('video-stream').src = `/video_feed?camera=${cameraNumber}`;
    fetchAreas(currentCamera);
}

// Añadir nueva cámara
async function addNewCamera() {
    if (userRole !== 'Admin') return;
    if (isModuleActive && selectedModule === 'Temperatura') {
        addEvent('No se puede añadir una cámara con el módulo Temperatura activo', 1000);
        return;
    }
    const currentCameraCount = document.querySelectorAll('.player-tabs button[data-camera]').length;
    if (currentCameraCount >= 4) {
        addEvent('Límite de 4 cámaras alcanzado.', 3000);
        return;
    }
    const url = prompt('Ingrese la URL de la nueva cámara (RTSP):');
    if (!url) return;
    const newCameraId = currentCameraCount + 1;
    const res = await fetch('/add_camera', {
        method: 'POST',
        headers: { 
            'Content-Type': 'application/json',
            'Authorization': sessionId
        },
        body: JSON.stringify({ camera_id: newCameraId, url })
    });
    const data = await res.json();
    if (data.status === 'success') {
        const playerTabs = document.querySelector('.player-tabs');
        const newButton = document.createElement('button');
        newButton.dataset.camera = newCameraId;
        newButton.textContent = `Cam ${newCameraId}`;
        newButton.addEventListener('click', () => onCameraClick(newCameraId));
        newButton.addEventListener('contextmenu', (e) => onCameraRightClick(e, newCameraId));
        playerTabs.insertBefore(newButton, document.getElementById('add-camera'));
        addEvent(`Cámara ${newCameraId} agregada`, 1000);
    } else {
        addEvent(`Error: ${data.message}`, 1000);
    }
}

// Aplicar módulo
async function applyModule() {
    if (userRole === 'Supervisor' && isModuleActive) return;
    if (!selectedModule) {
        addEvent('Seleccione un módulo primero', 1000);
        return;
    }
    const res = await fetch('/set_module', {
        method: 'POST',
        headers: { 
            'Content-Type': 'application/json',
            'Authorization': sessionId
        },
        body: JSON.stringify({ module: selectedModule, camera_id: currentCamera, active: true })
    });
    const data = await res.json();
    if (data.status === 'success') {
        isModuleActive = true;
        if (selectedModule === 'Temperatura') {
            onCameraClick(2);
        }
        updateModelStatus(data.model_active);
        updateConfigPanel();
        updateDetectionsPanel();
        addEvent(`Módulo ${selectedModule} activado`, 1000);
    }
}

// Cancelar módulo
async function cancelModule() {
    if (!isModuleActive || userRole === 'Supervisor') return;
    const res = await fetch('/set_module', {
        method: 'POST',
        headers: { 
            'Content-Type': 'application/json',
            'Authorization': sessionId
        },
        body: JSON.stringify({ module: null, camera_id: currentCamera, active: false })
    });
    const data = await res.json();
    if (data.status === 'success') {
        resetToDefault();
        onCameraClick(1);
        addEvent('Módulo cancelado', 1000);
    }
}

// Eliminar cámara con clic derecho
async function onCameraRightClick(event, cameraId) {
    if (userRole !== 'Admin') return;
    event.preventDefault();
    if (isModuleActive && selectedModule === 'Temperatura' && cameraId === 2) {
        addEvent('No se puede eliminar la cámara térmica con el módulo Temperatura activo', 1000);
        return;
    }
    const password = prompt('Ingrese la contraseña para eliminar esta cámara:');
    if (password === 'delete') {
        const res = await fetch('/delete_camera', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': sessionId
            },
            body: JSON.stringify({ camera_id: cameraId })
        });
        const data = await res.json();
        if (data.status === 'success') {
            document.querySelector(`.player-tabs button[data-camera="${cameraId}"]`).remove();
            if (currentCamera === cameraId) onCameraClick(1);
            addEvent(`Cámara ${cameraId} eliminada`, 1000);
        } else {
            addEvent(`Error: ${data.message}`, 1000);
        }
    } else {
        addEvent('Contraseña incorrecta', 1000);
    }
}

// Funciones para dibujar áreas restringidas
function onMousePress(event) {
    if (userRole !== 'Admin') return;
    if (isModuleActive && selectedModule === 'Áreas Restringidas' && event.button === 0) {
        isDrawing = true;
        startX = event.offsetX;
        startY = event.offsetY;
    }
}

function onMouseMove(event) {
    if (isDrawing && isModuleActive && selectedModule === 'Áreas Restringidas') {
        drawTemporaryRectangle(startX, startY, event.offsetX, event.offsetY);
    }
}

function onMouseRelease(event) {
    if (!isDrawing || !isModuleActive || selectedModule !== 'Áreas Restringidas' || event.button !== 0 || userRole !== 'Admin') return;
    isDrawing = false;
    const endX = event.offsetX, endY = event.offsetY;
    if (Math.abs(endX - startX) <= 10 || Math.abs(endY - startY) <= 10) return;
    const [x1, y1, x2, y2] = [Math.min(startX, endX), Math.min(startY, endY), Math.max(startX, endX), Math.max(startY, endY)];
    fetch('/add_rectangle', {
        method: 'POST',
        headers: { 
            'Content-Type': 'application/json',
            'Authorization': sessionId
        },
        body: JSON.stringify({ camera_id: currentCamera, x1, y1, x2, y2 })
    }).then(res => res.json()).then(data => {
        if (data.status === 'success') {
            addEvent(`Área guardada: X1=${x1}, Y1=${y1}, X2=${x2}, Y2=${y2}`, Infinity);
            fetchAreas(currentCamera);
        }
    });
    document.querySelector('#temp-area')?.remove();
}

function drawTemporaryRectangle(x1, y1, x2, y2) {
    document.querySelector('#temp-area')?.remove();
    const video = document.getElementById('video-stream');
    const videoRect = video.getBoundingClientRect();
    const area = document.createElement('div');
    area.id = 'temp-area';
    area.style.position = 'fixed';
    area.style.left = `${Math.min(x1, x2) + videoRect.left}px`;
    area.style.top = `${Math.min(y1, y2) + videoRect.top}px`;
    area.style.width = `${Math.abs(x2 - x1)}px`;
    area.style.height = `${Math.abs(y2 - y1)}px`;
    area.style.border = '2px solid green';
    area.style.backgroundColor = 'rgba(0, 255, 0, 0.3)';
    document.body.appendChild(area);
}

async function fetchAreas(cameraId) {
    const res = await fetch(`/load_areas?camera=${cameraId}`, {
        headers: { 'Authorization': sessionId }
    });
    const data = await res.json();
    if (data.status === 'success') {
        document.querySelectorAll('.area-overlay').forEach(area => area.remove());
        const video = document.getElementById('video-stream');
        const videoRect = video.getBoundingClientRect();
        data.areas.forEach(rect => {
            const area = document.createElement('div');
            area.className = `area-overlay area-${rect.area_type}`;
            area.style.position = 'fixed';
            area.style.left = `${rect.x1 + videoRect.left}px`;
            area.style.top = `${rect.y1 + videoRect.top}px`;
            area.style.width = `${rect.x2 - rect.x1}px`;
            area.style.height = `${rect.y2 - rect.y1}px`;
            document.body.appendChild(area);
        });
    }
}

// Cargar áreas desde archivo
function loadAreasFromFile() {
    if (userRole !== 'Admin') return;
    const fileInput = document.getElementById('area-file-input');
    fileInput.click();
}

async function handleFileSelect(event) {
    const file = event.target.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('file', file);
    formData.append('camera_id', currentCamera);
    const res = await fetch('/upload_areas', {
        method: 'POST',
        headers: { 'Authorization': sessionId },
        body: formData
    });
    const data = await res.json();
    if (data.status === 'success') {
        addEvent(`Áreas cargadas desde ${file.name}`, 1000);
        fetchAreas(currentCamera);
    } else {
        addEvent(`Error al cargar áreas: ${data.message}`, 1000);
    }
    event.target.value = '';
}

// Añadir evento
function addEvent(message, duration = 1000) {
    const eventsList = document.getElementById('events-list');
    const li = document.createElement('li');
    li.textContent = `${new Date().toLocaleString()} - ${message}`;
    eventsList.prepend(li);
    if (duration !== Infinity) setTimeout(() => li.remove(), duration);
}

// Añadir video a eventos
function addVideoEvent(videoPath) {
    const eventsList = document.getElementById('events-list');
    const li = document.createElement('li');
    const video = document.createElement('video');
    video.src = videoPath;
    video.controls = true;
    video.style.width = '100px';
    video.addEventListener('click', () => {
        const videoStream = document.getElementById('video-stream');
        videoStream.src = videoPath;
        videoStream.style.objectFit = 'contain';
    });
    li.appendChild(video);
    li.appendChild(document.createTextNode(` ${new Date().toLocaleString()} - Video grabado`));
    eventsList.prepend(li);
}

// Borrar eventos
function clearEvents() {
    if (userRole !== 'Admin') return;
    const password = prompt('Ingrese la contraseña para borrar eventos:');
    if (password === 'delete') {
        document.getElementById('events-list').innerHTML = '';
        addEvent('Eventos eliminados', 1000);
    } else {
        addEvent('Contraseña incorrecta', 1000);
    }
}

// Guardar áreas
async function saveAreas() {
    if (userRole !== 'Admin') return;
    const res = await fetch('/save_areas', {
        method: 'POST',
        headers: { 
            'Content-Type': 'application/json',
            'Authorization': sessionId
        },
        body: JSON.stringify({ camera_id: currentCamera })
    });
    const data = await res.json();
    addEvent(data.status === 'success'
        ? `Áreas guardadas en areas/areas_cam${currentCamera}.json`
        : `Error al guardar áreas: ${data.message}`, 1000);
}

// Establecer área actual
async function setCurrentArea(area) {
    if (!isModuleActive || selectedModule !== 'Áreas Restringidas' || userRole !== 'Admin') return;
    await fetch('/set_current_area', {
        method: 'POST',
        headers: { 
            'Content-Type': 'application/json',
            'Authorization': sessionId
        },
        body: JSON.stringify({ camera_id: currentCamera, area })
    });
    addEvent(`Área actual: ${area}`, 1000);
}

// Eliminar área
async function deleteArea(areaType) {
    if (!isModuleActive || selectedModule !== 'Áreas Restringidas' || userRole !== 'Admin') return;
    const res = await fetch('/delete_area', {
        method: 'POST',
        headers: { 
            'Content-Type': 'application/json',
            'Authorization': sessionId
        },
        body: JSON.stringify({ camera_id: currentCamera, area_type: areaType })
    });
    const data = await res.json();
    if (data.status === 'success') {
        addEvent(`Área ${areaType} eliminada`, 1000);
        fetchAreas(currentCamera);
    }
}

// Eliminar todas las áreas
async function deleteAllAreas() {
    if (!isModuleActive || selectedModule !== 'Áreas Restringidas' || userRole !== 'Admin') return;
    const res = await fetch('/delete_all_areas', {
        method: 'POST',
        headers: { 
            'Content-Type': 'application/json',
            'Authorization': sessionId
        },
        body: JSON.stringify({ camera_id: currentCamera })
    });
    const data = await res.json();
    if (data.status === 'success') {
        addEvent('Todas las áreas eliminadas', 1000);
        fetchAreas(currentCamera);
    }
}

// Chequear nuevos videos
async function checkForNewVideos() {
    const res = await fetch('/videos', {
        headers: { 'Authorization': sessionId }
    });
    const data = await res.json();
    if (data.status === 'success' && data.videos.length > lastVideoCount) {
        const newVideos = data.videos.slice(lastVideoCount);
        newVideos.forEach(video => addVideoEvent(`/videos/${video}`));
        lastVideoCount = data.videos.length;
    }
}

// Actualizar detecciones
async function updateDetections() {
    if (!isModuleActive) return;
    const res = await fetch(`/detections?camera=${currentCamera}&module=${selectedModule}`, {
        headers: { 'Authorization': sessionId }
    });
    const data = await res.json();
    if (data.status === 'success') {
        if (selectedModule === 'Áreas Restringidas') {
            document.getElementById('area1').checked = data.person_in_area[1];
            document.getElementById('area2').checked = data.person_in_area[2];
        } else if (selectedModule === "EPP's") {
            ['Casco', 'Gafas', 'Tapabocas', 'Protector auditivo', 'Guantes', 'Botas', 'Laminadora', 'Persona'].forEach(opt => {
                const id = `detect-${opt.toLowerCase().replace(' ', '-')}`;
                document.getElementById(id).checked = data.detections[opt];
            });
        }
    }
}