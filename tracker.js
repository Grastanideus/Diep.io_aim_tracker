console.log('[DiepTracker] v4: Optimized + Grid Compensation');

// --- НАСТРОЙКИ ---
const CONFIG = {
    // Оптимизация
    analysisScale: 0.25,   // Анализируем картинку в 4 раза меньше (супер скорость)
    
    // Поиск шаров
    tolerance: 15,
    minClusterSize: 2,     // Меньше, т.к. разрешение ниже
    clusterDist: 10,       // Меньше, т.к. разрешение ниже
    
    // Траектории
    trailLength: 30,
    
    // Сетка (фон ~205, сетка ~200)
    gridThreshold: 203     // Все что темнее этого - считается сеткой
};

const TARGETS = {
    red:    { r: 241, g: 78,  b: 84,  hex: '#FF0000' },
    blue:   { r: 0,   g: 176, b: 225, hex: '#00B0E1' },
    green:  { r: 0,   g: 225, b: 110, hex: '#00E16E' },
    purple: { r: 191, g: 127, b: 245, hex: '#BF7FF5' }
};

let trajectories = [];
let nextId = 1;

// Виртуальный маленький канвас для анализа
let smallCanvas = document.createElement('canvas');
let smallCtx = smallCanvas.getContext('2d', { willReadFrequently: true });

// Данные для отслеживания движения сетки
let gridState = {
    lastX: null,
    lastY: null,
    valid: false
};

function initTracker() {
    const canvas = document.getElementById('canvas'); 
    if (!canvas) { setTimeout(initTracker, 500); return; }

    // Основной контекст для рисования линий (высокое разрешение)
    const ctx = canvas.getContext('2d');
    
    const originalRequestAnimationFrame = window.requestAnimationFrame;
    window.requestAnimationFrame = function(callback) {
        return originalRequestAnimationFrame(function(timestamp) {
            if (typeof callback === 'function') callback(timestamp);
            // Запускаем наш процесс
            processFrame(canvas, ctx);
        });
    };
}

function processFrame(sourceCanvas, displayCtx) {
    const w = sourceCanvas.width;
    const h = sourceCanvas.height;
    
    // --- 1. АНАЛИЗ ДВИЖЕНИЯ КАМЕРЫ (GRID TRACKING) ---
    // Берем полоски пикселей с ОРИГИНАЛЬНОГО канваса (для точности линий)
    // Центральная горизонталь и вертикаль
    const midY = Math.floor(h / 2);
    const midX = Math.floor(w / 2);
    
    // Читаем только крестовину (очень быстро)
    const rowData = displayCtx.getImageData(0, midY, w, 1).data;
    const colData = displayCtx.getImageData(midX, 0, 1, h).data;
    
    const cameraMove = calculateCameraMovement(rowData, colData, w, h);
    
    // Корректируем старые траектории на движение камеры
    if (cameraMove.moved) {
        adjustTrajectories(cameraMove.dx, cameraMove.dy);
    }

    // --- 2. ПОДГОТОВКА СЖАТОГО КАДРА ДЛЯ ПОИСКА ШАРОВ ---
    const sw = Math.floor(w * CONFIG.analysisScale);
    const sh = Math.floor(h * CONFIG.analysisScale);
    
    if (smallCanvas.width !== sw) {
        smallCanvas.width = sw;
        smallCanvas.height = sh;
    }
    
    // Рисуем уменьшенную копию игры
    smallCtx.drawImage(sourceCanvas, 0, 0, sw, sh);
    const imageData = smallCtx.getImageData(0, 0, sw, sh);
    const data = imageData.data;

    // --- 3. ПОИСК ШАРОВ (На малом разрешении) ---
    let blobs = [];
    
    // Проходим по уменьшенной картинке
    // Шаг 1, так как картинка и так маленькая
    for (let y = 0; y < sh; y++) {
        for (let x = 0; x < sw; x++) {
            const i = (y * sw + x) * 4;
            // Проверка цвета
            const r = data[i], g = data[i+1], b = data[i+2];

            let matchedColor = null;
            // Быстрая проверка "похожести" на серый (фон) чтобы не перебирать цвета зря
            if (Math.abs(r - g) < 20 && Math.abs(g - b) < 20) continue; 

            for (const [key, color] of Object.entries(TARGETS)) {
                // Упрощенная проверка (Манхэттен)
                if (Math.abs(r - color.r) + Math.abs(g - color.g) + Math.abs(b - color.b) < CONFIG.tolerance * 3) {
                    matchedColor = key;
                    break;
                }
            }

            if (matchedColor) {
                // Кластеризация
                let found = false;
                for (let blob of blobs) {
                    if (blob.color === matchedColor) {
                        const dx = x - blob.sx / blob.count;
                        const dy = y - blob.sy / blob.count;
                        if (dx*dx + dy*dy < CONFIG.clusterDist * CONFIG.clusterDist) {
                            blob.sx += x;
                            blob.sy += y;
                            blob.count++;
                            found = true;
                            break;
                        }
                    }
                }
                if (!found) blobs.push({ sx: x, sy: y, count: 1, color: matchedColor });
            }
        }
    }

    // Преобразуем координаты обратно в полный размер
    const currentBalls = [];
    const scale = 1 / CONFIG.analysisScale;
    
    for (let blob of blobs) {
        if (blob.count >= CONFIG.minClusterSize) {
            currentBalls.push({
                x: (blob.sx / blob.count) * scale,
                y: (blob.sy / blob.count) * scale,
                color: blob.color
            });
        }
    }

    // --- 4. ОБНОВЛЕНИЕ ТРЕКОВ ---
    updateTrajectories(currentBalls);

    // --- 5. ОТРИСОВКА ---
    drawOverlay(displayCtx);
}

function calculateCameraMovement(row, col, w, h) {
    // Ищем ближайшую линию сетки к центру
    // Сетка темнее фона. Фон ~204, Сетка ~200.
    
    const findGridLine = (data, length) => {
        let bestPos = -1;
        let minBrightness = 255;
        // Ищем в радиусе 100 пикселей от центра
        const center = Math.floor(length / 2);
        const range = 50; 
        
        for (let i = center - range; i < center + range; i++) {
            const idx = i * 4;
            const brightness = (data[idx] + data[idx+1] + data[idx+2]) / 3;
            
            if (brightness < CONFIG.gridThreshold && brightness < minBrightness) {
                minBrightness = brightness;
                bestPos = i;
            }
        }
        return bestPos;
    };

    const gridX = findGridLine(row, w); // Вертикальная линия (измеряем X)
    const gridY = findGridLine(col, h); // Горизонтальная линия (измеряем Y)

    let result = { moved: false, dx: 0, dy: 0 };

    if (gridX !== -1 && gridY !== -1) {
        if (gridState.valid) {
            // Считаем дельту
            let dx = gridX - gridState.lastX;
            let dy = gridY - gridState.lastY;

            // Фильтр телепортации (если нашли другую линию сетки)
            // Игрок не может прыгнуть на 20 пикселей за кадр
            if (Math.abs(dx) < 20 && Math.abs(dy) < 20) {
                result.moved = true;
                result.dx = dx; // Если сетка уехала вправо (dx > 0), значит камера уехала влево
                result.dy = dy;
            }
        }
        
        gridState.lastX = gridX;
        gridState.lastY = gridY;
        gridState.valid = true;
    } else {
        gridState.valid = false; // Потеряли сетку
    }

    return result;
}

function adjustTrajectories(dx, dy) {
    // Если сетка сместилась на +5px (вправо), значит мы сдвинулись влево.
    // Объекты на экране "уехали" вправо.
    // Чтобы линия осталась привязанной к карте, мы должны сдвинуть её точки.
    // Логика относительности:
    // ScreenPos = WorldPos - CameraPos
    // OldScreen = W - C_old
    // NewScreen = W - C_new
    // Delta = New - Old = -(C_new - C_old) = -CameraMove
    // Значит, чтобы "удержать" точку на месте в мире, нужно:
    // Point.x -= dx;
    // Point.y -= dy;
    
    for (let track of trajectories) {
        for (let p of track.points) {
            p.x -= dx;
            p.y -= dy;
        }
    }
}

function updateTrajectories(balls) {
    for (let track of trajectories) {
        track.updated = false;
        let bestDist = 80; // Увеличили радиус поиска т.к. может быть быстрый сдвиг
        let bestIdx = -1;

        const last = track.points[track.points.length - 1];
        
        for (let i = 0; i < balls.length; i++) {
            if (balls[i].color !== track.color) continue;
            
            // Расстояние
            const dist = Math.hypot(balls[i].x - last.x, balls[i].y - last.y);
            
            if (dist < bestDist) {
                bestDist = dist;
                bestIdx = i;
            }
        }

        if (bestIdx !== -1) {
            track.points.push({ x: balls[bestIdx].x, y: balls[bestIdx].y });
            if (track.points.length > CONFIG.trailLength) track.points.shift();
            track.updated = true;
            balls.splice(bestIdx, 1);
        }
    }

    // Новые
    for (let b of balls) {
        trajectories.push({
            id: nextId++,
            color: b.color,
            points: [{x: b.x, y: b.y}],
            updated: true
        });
    }
    
    // Удаление потерянных
    trajectories = trajectories.filter(t => t.updated);
}

function drawOverlay(ctx) {
    ctx.save();
    ctx.lineWidth = 2;
    
    for (let track of trajectories) {
        if (track.points.length < 2) continue;
        
        ctx.strokeStyle = TARGETS[track.color].hex;
        ctx.beginPath();
        // Рисуем линию
        ctx.moveTo(track.points[0].x, track.points[0].y);
        for (let i = 1; i < track.points.length; i++) {
            ctx.lineTo(track.points[i].x, track.points[i].y);
        }
        ctx.stroke();
    }
    ctx.restore();
}

initTracker();