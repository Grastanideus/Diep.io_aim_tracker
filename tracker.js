console.log('[DiepTracker] v5: Smoothing, Zones & Backtracing');

const CONFIG = {
    // ОПТИМИЗАЦИЯ
    scale: 0.25,           // Размер анализа (0.25 = 1/16 пикселей)
    scanStep: 2,           // Пропускаем пиксели даже в уменьшенной копии (еще быстрее)
    
    // СГЛАЖИВАНИЕ (Убирает дребезг)
    smoothFactor: 0.3,     // 0.1 = очень плавно (вязко), 1.0 = мгновенно (дребезг). 0.3 - золотая середина.
    
    // ФИЛЬТРЫ ЗОН (В пикселях реального экрана)
    ignoreMinimap: 200,    // Размер зоны в углу (игнор карты)
    ignoreCenter: 60,      // Радиус вокруг игрока (игнор своего танка)
    
    // ТРЕКИНГ
    tolerance: 15,
    trailLength: 25,
    minCluster: 2,         // Минимальный размер объекта (в сжатых пикселях)
    
    // ВИЗУАЛ
    predictionLen: 400     // Длина пунктира "откуда прилетело"
};

const TARGETS = {
    red:    { r: 241, g: 78,  b: 84,  hex: '#FF4444' },    // Чуть ярче для видимости
    blue:   { r: 0,   g: 176, b: 225, hex: '#44CCFF' },
    purple: { r: 191, g: 127, b: 245, hex: '#D088FF' },
    green:  { r: 0,   g: 225, b: 110, hex: '#00FF80' }
};

// Состояние
let trajectories = [];
let nextId = 1;
let smallCanvas = document.createElement('canvas');
let smallCtx = smallCanvas.getContext('2d', { willReadFrequently: true });
let gridState = { lastX: 0, lastY: 0, hasData: false };

function initTracker() {
    const canvas = document.getElementById('canvas'); 
    if (!canvas) { setTimeout(initTracker, 500); return; }

    const ctx = canvas.getContext('2d');
    const originalRequestAnimationFrame = window.requestAnimationFrame;

    window.requestAnimationFrame = function(callback) {
        return originalRequestAnimationFrame(function(timestamp) {
            if (typeof callback === 'function') callback(timestamp);
            processFrame(canvas, ctx);
        });
    };
}

function processFrame(sourceCanvas, displayCtx) {
    const w = sourceCanvas.width;
    const h = sourceCanvas.height;
    
    // --- 1. КОРРЕКЦИЯ СЕТКИ (GRID) ---
    // Используем центральные полосы для отслеживания фона
    const gridMove = getGridShift(displayCtx, w, h);
    
    if (gridMove.shifted) {
        // Сдвигаем все прошлые точки, чтобы они прилипли к миру
        for (let t of trajectories) {
            for (let p of t.points) {
                p.x -= gridMove.dx;
                p.y -= gridMove.dy;
            }
        }
    }

    // --- 2. ПОДГОТОВКА (DOWNSCALE) ---
    const sw = Math.floor(w * CONFIG.scale);
    const sh = Math.floor(h * CONFIG.scale);
    
    if (smallCanvas.width !== sw) { smallCanvas.width = sw; smallCanvas.height = sh; }
    
    smallCtx.drawImage(sourceCanvas, 0, 0, sw, sh);
    const imgData = smallCtx.getImageData(0, 0, sw, sh);
    const data = imgData.data;

    // --- 3. ПОИСК ОБЪЕКТОВ ---
    let blobs = [];
    const step = CONFIG.scanStep;
    
    // Границы для игнора миникарты (в координатах smallCanvas)
    const mapLimitX = sw - (CONFIG.ignoreMinimap * CONFIG.scale);
    const mapLimitY = sh - (CONFIG.ignoreMinimap * CONFIG.scale);
    
    // Центр для игнора игрока
    const cx = sw / 2;
    const cy = sh / 2;
    const centerRadSq = (CONFIG.ignoreCenter * CONFIG.scale) ** 2;

    for (let y = 0; y < sh; y += step) {
        // Пропускаем низ экрана если мы справа (миникарта)
        const isBottom = y > mapLimitY;
        const limitX = isBottom ? mapLimitX : sw;

        for (let x = 0; x < limitX; x += step) {
            // Игнор центра (игрок)
            const dx = x - cx;
            const dy = y - cy;
            if (dx*dx + dy*dy < centerRadSq) continue;

            const i = (y * sw + x) * 4;
            // Быстрый префильтр: пропускаем серый/белый фон
            // Если насыщенность низкая (|r-g| + |g-b| мал), пропускаем
            if (Math.abs(data[i] - data[i+1]) < 20 && Math.abs(data[i+1] - data[i+2]) < 20) continue;

            const r = data[i], g = data[i+1], b = data[i+2];

            for (const [key, t] of Object.entries(TARGETS)) {
                // Манхэттенское расстояние (быстро)
                if (Math.abs(r - t.r) + Math.abs(g - t.g) + Math.abs(b - t.b) < CONFIG.tolerance * 3) {
                    addPixelToBlobs(blobs, x, y, key);
                    break;
                }
            }
        }
    }

    // --- 4. КОНВЕРТАЦИЯ В КООРДИНАТЫ ---
    const scaleInv = 1 / CONFIG.scale;
    const detectedObjects = [];
    
    for (let b of blobs) {
        if (b.count >= CONFIG.minCluster) {
            detectedObjects.push({
                x: (b.sx / b.count) * scaleInv,
                y: (b.sy / b.count) * scaleInv,
                color: b.color
            });
        }
    }

    // --- 5. ТРЕКИНГ СО СГЛАЖИВАНИЕМ ---
    updateTrajectories(detectedObjects);

    // --- 6. ОТРИСОВКА ---
    drawOverlay(displayCtx);
}

// Упрощенная кластеризация "на лету"
function addPixelToBlobs(blobs, x, y, color) {
    // Ищем близкий blob
    // Дистанция 15px в малом масштабе = 60px в реальном
    const distLimit = 15; 
    
    for (let b of blobs) {
        if (b.color === color) {
            // Проверяем расстояние до центра масс (приближенно)
            const curX = b.sx / b.count;
            const curY = b.sy / b.count;
            if (Math.abs(x - curX) + Math.abs(y - curY) < distLimit) {
                b.sx += x; b.sy += y; b.count++;
                return;
            }
        }
    }
    blobs.push({ sx: x, sy: y, count: 1, color: color });
}

function updateTrajectories(objects) {
    for (let t of trajectories) {
        t.updated = false;
        let bestIdx = -1;
        let bestDist = 100;

        // Предсказанная позиция (где шар должен быть по инерции)
        // Это помогает не терять трек при быстрых движениях
        let predX = t.x;
        let predY = t.y;
        if (t.points.length > 1) {
            const last = t.points[t.points.length-1];
            const prev = t.points[t.points.length-2];
            predX += (last.x - prev.x);
            predY += (last.y - prev.y);
        }

        for (let i = 0; i < objects.length; i++) {
            if (objects[i].color !== t.color) continue;
            const dist = Math.hypot(objects[i].x - predX, objects[i].y - predY);
            if (dist < bestDist) {
                bestDist = dist;
                bestIdx = i;
            }
        }

        if (bestIdx !== -1) {
            const obj = objects[bestIdx];
            
            // LERP СГЛАЖИВАНИЕ!
            // Новая позиция = Старая * (1-F) + Новая * F
            // Это убивает дрожание
            t.x = t.x * (1 - CONFIG.smoothFactor) + obj.x * CONFIG.smoothFactor;
            t.y = t.y * (1 - CONFIG.smoothFactor) + obj.y * CONFIG.smoothFactor;
            
            t.points.push({ x: t.x, y: t.y });
            if (t.points.length > CONFIG.trailLength) t.points.shift();
            
            t.updated = true;
            objects.splice(bestIdx, 1);
        }
    }

    // Новые объекты
    for (let obj of objects) {
        trajectories.push({
            id: nextId++,
            color: obj.color,
            x: obj.x, // Текущая "сглаженная" голова
            y: obj.y,
            points: [{x: obj.x, y: obj.y}],
            updated: true
        });
    }
    
    trajectories = trajectories.filter(t => t.updated);
}

function getGridShift(ctx, w, h) {
    // Очень быстрый скан одной линии для детекции сдвига
    // Ищем самую темную точку (линию сетки)
    const midX = Math.floor(w/2);
    const midY = Math.floor(h/2);
    
    // Сканируем только +-50 пикселей от центра
    const range = 60;
    const dataX = ctx.getImageData(midX - range, midY, range * 2, 1).data;
    const dataY = ctx.getImageData(midX, midY - range, 1, range * 2).data;
    
    let minLumX = 255, gridX = -1;
    let minLumY = 255, gridY = -1;

    for(let i=0; i<range*2; i++) {
        // Яркость
        const lumX = (dataX[i*4] + dataX[i*4+1] + dataX[i*4+2]) / 3;
        if (lumX < 205 && lumX < minLumX) { minLumX = lumX; gridX = i; }
        
        const lumY = (dataY[i*4] + dataY[i*4+1] + dataY[i*4+2]) / 3;
        if (lumY < 205 && lumY < minLumY) { minLumY = lumY; gridY = i; }
    }

    let res = { shifted: false, dx: 0, dy: 0 };
    
    if (gridX !== -1 && gridY !== -1) {
        if (gridState.hasData) {
            const dx = gridX - gridState.lastX;
            const dy = gridY - gridState.lastY;
            // Фильтр скачков (телепортации сетки)
            if (Math.abs(dx) < 20 && Math.abs(dy) < 20) {
                // Если dx != 0, значит фон сдвинулся
                res.dx = dx;
                res.dy = dy;
                res.shifted = true;
            }
        }
        gridState.lastX = gridX;
        gridState.lastY = gridY;
        gridState.hasData = true;
    }
    return res;
}

function drawOverlay(ctx) {
    ctx.save();
    
    for (let t of trajectories) {
        if (t.points.length < 3) continue;
        const color = TARGETS[t.color].hex;
        
        // 1. Рисуем реальный хвост
        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        // Рисуем кривую Безье по точкам для красоты (или просто линии)
        ctx.moveTo(t.points[0].x, t.points[0].y);
        for (let i = 1; i < t.points.length; i++) {
            ctx.lineTo(t.points[i].x, t.points[i].y);
        }
        ctx.stroke();
        
        // 2. Рисуем "Откуда прилетело" (Обратный вектор)
        // Берем средний вектор движения за последние 5 кадров
        const pLen = t.points.length;
        const p1 = t.points[pLen - 1]; // Голова
        const p2 = t.points[Math.max(0, pLen - 5)]; // Хвост (чуть назад)
        
        if (p1 && p2 && p1 !== p2) {
            const vx = p1.x - p2.x;
            const vy = p1.y - p2.y;
            const mod = Math.hypot(vx, vy);
            
            // Рисуем только если объект движется (вектор не нулевой)
            if (mod > 2) {
                // Нормализация и удлинение назад
                const dirX = vx / mod;
                const dirY = vy / mod;
                
                ctx.beginPath();
                ctx.strokeStyle = color;
                ctx.globalAlpha = 0.5; // Полупрозрачный
                ctx.setLineDash([5, 5]); // Пунктир
                ctx.moveTo(p2.x, p2.y); // От хвоста
                ctx.lineTo(p2.x - dirX * CONFIG.predictionLen, p2.y - dirY * CONFIG.predictionLen); // Назад далеко
                ctx.stroke();
                ctx.setLineDash([]);
                ctx.globalAlpha = 1.0;
            }
        }
    }
    
    // Рисуем зоны игнора (для отладки можно включить, сейчас невидимы)
    // ctx.strokeStyle = 'yellow'; ctx.strokeRect(w/2 - 50, h/2 - 50, 100, 100); 

    ctx.restore();
}

initTracker();