console.log('[DiepTracker] v6: Smart Sparse Scan + Vector Inertia');

const CONFIG = {
    // СКАНИРОВАНИЕ
    scanStep: 8,           // Сканируем только каждый 8-й пиксель (очень быстро)
    refineRadius: 15,      // Если нашли цвет, ищем точный центр в этом радиусе
    
    // ФИЛЬТРЫ
    ignoreMinimap: 200,    // Размер миникарты
    ignoreCenter: 70,      // Радиус вокруг своего танка
    tolerance: 15,         // Допуск цвета
    
    // ФИЗИКА И СГЛАЖИВАНИЕ
    posSmoothing: 0.3,     // Сглаживание позиции (0.1 - желе, 1.0 - жестко)
    vecSmoothing: 0.1,     // Сглаживание вектора скорости (чем меньше, тем стабильнее пунктир)
    minSpeed: 2.0,         // Минимальная скорость для отрисовки пунктира (фильтр шума)
    
    // ВИЗУАЛ
    predictionLen: 600,    // Длина пунктира поиска источника
    trailLength: 20
};

const TARGETS = {
    red:    { r: 241, g: 78,  b: 84,  hex: '#FF4444' },
    blue:   { r: 0,   g: 176, b: 225, hex: '#44CCFF' },
    purple: { r: 191, g: 127, b: 245, hex: '#D088FF' },
    green:  { r: 0,   g: 225, b: 110, hex: '#00FF80' }
};

let trajectories = [];
let nextId = 1;
let gridState = { lastX: 0, lastY: 0, hasData: false };

function initTracker() {
    const canvas = document.getElementById('canvas'); 
    if (!canvas) { setTimeout(initTracker, 500); return; }

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    
    const originalRequestAnimationFrame = window.requestAnimationFrame;
    window.requestAnimationFrame = function(callback) {
        return originalRequestAnimationFrame(function(timestamp) {
            if (typeof callback === 'function') callback(timestamp);
            processFrame(canvas, ctx);
        });
    };
}

function processFrame(canvas, ctx) {
    const w = canvas.width;
    const h = canvas.height;
    
    // 1. ПОЛУЧАЕМ ПОЛНУЮ КАРТИНКУ (Это быстро, если не бегать по массиву лишний раз)
    const imgData = ctx.getImageData(0, 0, w, h);
    const data = imgData.data;

    // 2. КОРРЕКЦИЯ СЕТКИ (GRID)
    const gridMove = getGridShift(data, w, h);
    if (gridMove.shifted) {
        for (let t of trajectories) {
            t.x -= gridMove.dx;
            t.y -= gridMove.dy;
            for (let p of t.points) {
                p.x -= gridMove.dx;
                p.y -= gridMove.dy;
            }
        }
    }

    // 3. УМНОЕ СКАНИРОВАНИЕ (SPARSE SCAN)
    // Ищем объекты на полном разрешении, но с большим шагом
    const balls = [];
    const step = CONFIG.scanStep;
    
    // Массив занятости, чтобы не детектить один шар дважды
    // Используем простую хеш-сетку
    const visited = new Set();
    const getGridKey = (x, y) => `${Math.floor(x/30)},${Math.floor(y/30)}`;

    const cx = w / 2;
    const cy = h / 2;
    const centerRadSq = CONFIG.ignoreCenter ** 2;

    for (let y = 0; y < h; y += step) {
        // Пропуск миникарты
        if (y > h - CONFIG.ignoreMinimap && x > w - CONFIG.ignoreMinimap) continue;
        
        for (let x = 0; x < w; x += step) {
            // Игнор центра
            const dx = x - cx;
            const dy = y - cy;
            if (dx*dx + dy*dy < centerRadSq) continue;
            
            // Пропуск если зона уже обработана (мы нашли там шар)
            if (visited.has(getGridKey(x, y))) continue;

            const idx = (y * w + x) * 4;
            // Быстрый фильтр "не серое ли это"
            if (Math.abs(data[idx] - data[idx+1]) < 20 && Math.abs(data[idx+1] - data[idx+2]) < 20) continue;

            // Проверка цветов
            let match = null;
            const r = data[idx], g = data[idx+1], b = data[idx+2];
            
            for (const [key, t] of Object.entries(TARGETS)) {
                if (Math.abs(r - t.r) + Math.abs(g - t.g) + Math.abs(b - t.b) < CONFIG.tolerance * 3) {
                    match = key;
                    break;
                }
            }

            if (match) {
                // МЫ НАШЛИ ПИКСЕЛЬ! ТЕПЕРЬ ИЩЕМ ЦЕНТР ЭТОГО ОБЪЕКТА
                const center = refineCenter(data, w, h, x, y, match, visited);
                balls.push({ x: center.x, y: center.y, color: match });
            }
        }
    }

    // 4. ТРЕКИНГ С ВЕКТОРНОЙ ИНЕРЦИЕЙ
    updateTrajectories(balls);

    // 5. ОТРИСОВКА
    drawOverlay(ctx);
}

// Функция точного поиска центра вокруг найденного пикселя
function refineCenter(data, w, h, startX, startY, colorKey, visited) {
    let sumX = 0, sumY = 0, count = 0;
    const target = TARGETS[colorKey];
    const rLim = CONFIG.refineRadius;
    
    // Сканируем квадрат вокруг точки
    for (let y = startY - rLim; y <= startY + rLim; y += 2) { // шаг 2 для скорости
        if (y < 0 || y >= h) continue;
        for (let x = startX - rLim; x <= startX + rLim; x += 2) {
            if (x < 0 || x >= w) continue;
            
            const i = (y * w + x) * 4;
            const r = data[i], g = data[i+1], b = data[i+2];
            
            if (Math.abs(r - target.r) + Math.abs(g - target.g) + Math.abs(b - target.b) < CONFIG.tolerance * 3) {
                sumX += x;
                sumY += y;
                count++;
            }
        }
    }
    
    const centerX = count > 0 ? sumX / count : startX;
    const centerY = count > 0 ? sumY / count : startY;

    // Помечаем эту зону как посещенную
    const gk = `${Math.floor(centerX/30)},${Math.floor(centerY/30)}`;
    visited.add(gk);
    // И соседей, чтобы наверняка
    visited.add(`${Math.floor(centerX/30)+1},${Math.floor(centerY/30)}`);
    visited.add(`${Math.floor(centerX/30)-1},${Math.floor(centerY/30)}`);
    visited.add(`${Math.floor(centerX/30)},${Math.floor(centerY/30)+1}`);
    visited.add(`${Math.floor(centerX/30)},${Math.floor(centerY/30)-1}`);

    return { x: centerX, y: centerY };
}


function updateTrajectories(balls) {
    for (let t of trajectories) {
        t.updated = false;
        
        // Предсказание на основе текущей скорости
        let predX = t.x + t.vx;
        let predY = t.y + t.vy;
        
        let bestIdx = -1;
        let bestDist = 100;

        for (let i = 0; i < balls.length; i++) {
            if (balls[i].color !== t.color) continue;
            
            const dist = Math.hypot(balls[i].x - predX, balls[i].y - predY);
            if (dist < bestDist) {
                bestDist = dist;
                bestIdx = i;
            }
        }

        if (bestIdx !== -1) {
            const obj = balls[bestIdx];
            
            // СГЛАЖИВАНИЕ ПОЗИЦИИ
            const smoothX = t.x * (1 - CONFIG.posSmoothing) + obj.x * CONFIG.posSmoothing;
            const smoothY = t.y * (1 - CONFIG.posSmoothing) + obj.y * CONFIG.posSmoothing;
            
            // ВЫЧИСЛЕНИЕ МГНОВЕННОЙ СКОРОСТИ
            const instVx = smoothX - t.x;
            const instVy = smoothY - t.y;
            
            // СГЛАЖИВАНИЕ ВЕКТОРА (ИНЕРЦИЯ) !!!
            // Вот это уберет дребезг пунктира
            t.vx = t.vx * (1 - CONFIG.vecSmoothing) + instVx * CONFIG.vecSmoothing;
            t.vy = t.vy * (1 - CONFIG.vecSmoothing) + instVy * CONFIG.vecSmoothing;
            
            t.x = smoothX;
            t.y = smoothY;
            
            t.points.push({ x: t.x, y: t.y });
            if (t.points.length > CONFIG.trailLength) t.points.shift();
            
            t.updated = true;
            balls.splice(bestIdx, 1);
        } else {
            // Если потеряли объект, плавно гасим скорость, чтобы не висела старая линия
            t.vx *= 0.9;
            t.vy *= 0.9;
        }
    }

    // Новые
    for (let b of balls) {
        trajectories.push({
            id: nextId++,
            color: b.color,
            x: b.x,
            y: b.y,
            vx: 0, // Начальная скорость 0
            vy: 0,
            points: [{x: b.x, y: b.y}],
            updated: true
        });
    }
    
    // Удаляем старые
    // Даем им пожить пару кадров "по памяти" (grace period) если нужно, но пока удаляем
    trajectories = trajectories.filter(t => t.updated);
}

// Упрощенная логика сетки для Image Data
function getGridShift(data, w, h) {
    const midY = Math.floor(h/2);
    const midX = Math.floor(w/2);
    const range = 80;
    
    // Поиск по горизонтали (в центре)
    let bestX = -1, minLum = 255;
    // Проходим ряд пикселей
    const rowOffset = midY * w * 4;
    for (let x = midX - range; x < midX + range; x++) {
        const i = rowOffset + x * 4;
        const lum = (data[i] + data[i+1] + data[i+2]) / 3;
        if (lum < 205 && lum < minLum) { minLum = lum; bestX = x; }
    }
    
    // Поиск по вертикали
    let bestY = -1; minLum = 255;
    for (let y = midY - range; y < midY + range; y++) {
        const i = (y * w + midX) * 4;
        const lum = (data[i] + data[i+1] + data[i+2]) / 3;
        if (lum < 205 && lum < minLum) { minLum = lum; bestY = y; }
    }

    let res = { shifted: false, dx: 0, dy: 0 };
    
    if (bestX !== -1 && bestY !== -1) {
        if (gridState.hasData) {
            const dx = bestX - gridState.lastX;
            const dy = bestY - gridState.lastY;
            if (Math.abs(dx) < 25 && Math.abs(dy) < 25 && (dx !== 0 || dy !== 0)) {
                res.dx = dx;
                res.dy = dy;
                res.shifted = true;
            }
        }
        gridState.lastX = bestX;
        gridState.lastY = bestY;
        gridState.hasData = true;
    }
    return res;
}

function drawOverlay(ctx) {
    ctx.save();
    
    for (let t of trajectories) {
        if (t.points.length < 2) continue;
        const color = TARGETS[t.color].hex;
        
        // Траектория
        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.moveTo(t.points[0].x, t.points[0].y);
        for (let i = 1; i < t.points.length; i++) ctx.lineTo(t.points[i].x, t.points[i].y);
        ctx.stroke();
        
        // Вектор источника (Пунктир)
        // Рисуем ТОЛЬКО если скорость достаточно велика (фильтр стоячих объектов)
        const speed = Math.hypot(t.vx, t.vy);
        if (speed > CONFIG.minSpeed) {
            ctx.beginPath();
            ctx.strokeStyle = color;
            ctx.globalAlpha = 0.6;
            ctx.setLineDash([8, 8]);
            
            // Рисуем линию назад против вектора скорости
            // Используем t.vx/t.vy которые СГЛАЖЕНЫ во времени
            const startX = t.points[0].x; // От хвоста
            const startY = t.points[0].y;
            
            // Нормализуем вектор
            const dirX = t.vx / speed;
            const dirY = t.vy / speed;
            
            ctx.moveTo(startX, startY);
            ctx.lineTo(startX - dirX * CONFIG.predictionLen, startY - dirY * CONFIG.predictionLen);
            
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.globalAlpha = 1.0;
        }
    }
    ctx.restore();
}

initTracker();