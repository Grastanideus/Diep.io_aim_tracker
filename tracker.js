console.log('[DiepTracker] v7: Fix + Vector Averaging Buffer');

const CONFIG = {
    // СКАНИРОВАНИЕ
    scanStep: 8,           // Шаг сетки (оптимально 8-10)
    refineRadius: 20,      // Радиус уточнения центра
    
    // ФИЛЬТРЫ ЗОН
    ignoreMinimap: 200,    // Размер миникарты (справа снизу)
    ignoreCenter: 60,      // Радиус вокруг игрока
    
    // ТРЕКИНГ
    tolerance: 15,         // Допуск цвета
    maxDistToMatch: 80,    // Макс дистанция прыжка объекта между кадрами
    
    // ФИЗИКА И СТАБИЛИЗАЦИЯ
    posSmoothing: 0.4,     // Сглаживание позиции (0.4 = отзывчиво)
    historySize: 6,        // СКОЛЬКО КАДРОВ УСРЕДНЯТЬ (Чем больше, тем прямее линия, но больше лаг поворота)
    minSpeed: 1.5,         // Фильтр шума скорости
    
    // ВИЗУАЛ
    predictionLen: 500,    // Длина луча
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
    
    // 1. ПОЛУЧЕНИЕ ДАННЫХ
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

    // 3. ПОИСК ОБЪЕКТОВ
    const balls = [];
    const step = CONFIG.scanStep;
    const cx = w / 2;
    const cy = h / 2;
    const centerRadSq = CONFIG.ignoreCenter ** 2;

    // Границы миникарты
    const mapMinX = w - CONFIG.ignoreMinimap;
    const mapMinY = h - CONFIG.ignoreMinimap;

    for (let y = 0; y < h; y += step) {
        for (let x = 0; x < w; x += step) {
            // Игнор миникарты (ТЕПЕРЬ БЕЗ ОШИБКИ)
            if (x > mapMinX && y > mapMinY) continue;
            
            // Игнор центра
            const dx = x - cx;
            const dy = y - cy;
            if (dx*dx + dy*dy < centerRadSq) continue;
            
            const idx = (y * w + x) * 4;
            
            // Быстрый фильтр "не фон"
            if (Math.abs(data[idx] - data[idx+1]) < 20 && Math.abs(data[idx+1] - data[idx+2]) < 20) continue;

            // Проверка цвета
            let match = null;
            const r = data[idx], g = data[idx+1], b = data[idx+2];
            
            for (const [key, t] of Object.entries(TARGETS)) {
                if (Math.abs(r - t.r) + Math.abs(g - t.g) + Math.abs(b - t.b) < CONFIG.tolerance * 3) {
                    match = key;
                    break;
                }
            }

            if (match) {
                // Проверка: не нашли ли мы этот шар уже? (Дистанция < 30px до любого уже найденного)
                let alreadyFound = false;
                for (let b of balls) {
                    if (Math.abs(x - b.x) < 30 && Math.abs(y - b.y) < 30) {
                        alreadyFound = true;
                        break;
                    }
                }
                
                if (!alreadyFound) {
                    // Уточняем центр
                    const center = refineCenter(data, w, h, x, y, match);
                    balls.push({ x: center.x, y: center.y, color: match });
                }
            }
        }
    }

    // 4. ТРЕКИНГ
    updateTrajectories(balls);

    // 5. ОТРИСОВКА
    drawOverlay(ctx);
}

function refineCenter(data, w, h, startX, startY, colorKey) {
    let sumX = 0, sumY = 0, count = 0;
    const target = TARGETS[colorKey];
    const rLim = CONFIG.refineRadius;
    
    // Локальный скан вокруг точки
    for (let y = startY - rLim; y <= startY + rLim; y += 2) {
        if (y < 0 || y >= h) continue;
        for (let x = startX - rLim; x <= startX + rLim; x += 2) {
            if (x < 0 || x >= w) continue;
            
            const i = (y * w + x) * 4;
            const r = data[i], g = data[i+1], b = data[i+2];
            
            // Если цвет подходит
            if (Math.abs(r - target.r) + Math.abs(g - target.g) + Math.abs(b - target.b) < CONFIG.tolerance * 3) {
                sumX += x;
                sumY += y;
                count++;
            }
        }
    }
    
    return count > 0 
        ? { x: sumX / count, y: sumY / count } 
        : { x: startX, y: startY };
}


function updateTrajectories(balls) {
    for (let t of trajectories) {
        t.updated = false;
        
        // Предсказание
        let predX = t.x + t.vx;
        let predY = t.y + t.vy;
        
        let bestIdx = -1;
        let bestDist = CONFIG.maxDistToMatch;

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
            
            // Сглаживаем позицию
            const smoothX = t.x * (1 - CONFIG.posSmoothing) + obj.x * CONFIG.posSmoothing;
            const smoothY = t.y * (1 - CONFIG.posSmoothing) + obj.y * CONFIG.posSmoothing;
            
            // Мгновенная скорость
            const curVx = smoothX - t.x;
            const curVy = smoothY - t.y;
            
            // --- НОВОЕ: БУФЕР ИСТОРИИ ДЛЯ СТАБИЛИЗАЦИИ ВЕКТОРА ---
            t.vxHistory.push({ x: curVx, y: curVy });
            if (t.vxHistory.length > CONFIG.historySize) t.vxHistory.shift();
            
            // Считаем среднее арифметическое всех векторов в буфере
            let avgVx = 0, avgVy = 0;
            for (let v of t.vxHistory) { avgVx += v.x; avgVy += v.y; }
            t.vx = avgVx / t.vxHistory.length;
            t.vy = avgVy / t.vxHistory.length;
            // -----------------------------------------------------

            t.x = smoothX;
            t.y = smoothY;
            
            t.points.push({ x: t.x, y: t.y });
            if (t.points.length > CONFIG.trailLength) t.points.shift();
            
            t.updated = true;
            balls.splice(bestIdx, 1);
        }
    }

    // Новые объекты
    for (let b of balls) {
        trajectories.push({
            id: nextId++,
            color: b.color,
            x: b.x,
            y: b.y,
            vx: 0, 
            vy: 0,
            vxHistory: [], // Инициализируем пустой буфер
            points: [{x: b.x, y: b.y}],
            updated: true
        });
    }
    
    trajectories = trajectories.filter(t => t.updated);
}

// Image Data Grid check
function getGridShift(data, w, h) {
    const midY = Math.floor(h/2);
    const midX = Math.floor(w/2);
    const range = 80;
    
    let bestX = -1, minLum = 255;
    const rowOffset = midY * w * 4;
    for (let x = midX - range; x < midX + range; x++) {
        const i = rowOffset + x * 4;
        const lum = (data[i] + data[i+1] + data[i+2]) / 3;
        if (lum < 205 && lum < minLum) { minLum = lum; bestX = x; }
    }
    
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
                res.dx = dx; res.dy = dy; res.shifted = true;
            }
        }
        gridState.lastX = bestX; gridState.lastY = bestY; gridState.hasData = true;
    }
    return res;
}

function drawOverlay(ctx) {
    ctx.save();
    for (let t of trajectories) {
        if (t.points.length < 2) continue;
        const color = TARGETS[t.color].hex;
        
        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.moveTo(t.points[0].x, t.points[0].y);
        for (let i = 1; i < t.points.length; i++) ctx.lineTo(t.points[i].x, t.points[i].y);
        ctx.stroke();
        
        const speed = Math.hypot(t.vx, t.vy);
        if (speed > CONFIG.minSpeed) {
            ctx.beginPath();
            ctx.strokeStyle = color;
            ctx.globalAlpha = 0.6;
            ctx.setLineDash([8, 8]);
            
            const dirX = t.vx / speed;
            const dirY = t.vy / speed;
            
            // Используем усредненный вектор t.vx, t.vy
            const startX = t.points[t.points.length-1].x; // От головы
            const startY = t.points[t.points.length-1].y;

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