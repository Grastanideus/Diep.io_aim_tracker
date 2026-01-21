console.log('[DiepTracker] v8: Linear Regression & High Stability');

const CONFIG = {
    // СКАНИРОВАНИЕ
    scanStep: 8,           // Шаг сетки 
    refineRadius: 15,      // Радиус уточнения
    
    // ФИЛЬТРЫ
    ignoreMinimap: 200,
    ignoreCenter: 65,      // Чуть больше радиус, чтобы точно не цеплять пушки
    
    // ЦВЕТА
    tolerance: 15,
    
    // ФИЗИКА (ЛИНЕЙНАЯ РЕГРЕССИЯ)
    fitLength: 10,         // Сколько последних точек брать для расчета вектора (Больше = стабильнее)
    minPointsForFix: 4,    // Минимум точек, чтобы начать рисовать прогноз
    
    // ВИЗУАЛ
    predictionLen: 700,    // Длинный луч
    lineWidth: 1.5         // Тонкие линии
};

const TARGETS = {
    red:    { r: 241, g: 78,  b: 84,  hex: '#FF3333' },
    blue:   { r: 0,   g: 176, b: 225, hex: '#33BBFF' },
    purple: { r: 191, g: 127, b: 245, hex: '#CC66FF' },
    green:  { r: 0,   g: 225, b: 110, hex: '#00FF66' }
};

let trajectories = [];
let nextId = 1;
let gridState = { lastX: 0, lastY: 0, valid: false };

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
    const imgData = ctx.getImageData(0, 0, w, h);
    const data = imgData.data;

    // 1. КОРРЕКЦИЯ СЕТКИ (Улучшенная)
    const gridMove = getGridShift(data, w, h);
    if (gridMove.shifted) {
        for (let t of trajectories) {
            // Сдвигаем все точки истории
            for (let p of t.points) {
                p.x -= gridMove.dx;
                p.y -= gridMove.dy;
            }
            // Сдвигаем текущую сглаженную позицию
            t.x -= gridMove.dx;
            t.y -= gridMove.dy;
        }
    }

    // 2. ПОИСК (Как и раньше, но чуть строже)
    const balls = findBalls(data, w, h);

    // 3. ОБНОВЛЕНИЕ ТРАЕКТОРИЙ
    updateTrajectories(balls);

    // 4. РАСЧЕТ ВЕКТОРОВ (РЕГРЕССИЯ) И ОТРИСОВКА
    drawOverlay(ctx);
}

function findBalls(data, w, h) {
    const balls = [];
    const step = CONFIG.scanStep;
    const cx = w / 2, cy = h / 2;
    const centerRadSq = CONFIG.ignoreCenter ** 2;
    const mapMinX = w - CONFIG.ignoreMinimap;
    const mapMinY = h - CONFIG.ignoreMinimap;

    // Сетка занятости (оптимизация 1D массива)
    const gridSize = 40; 
    const gridW = Math.ceil(w / gridSize);
    const gridH = Math.ceil(h / gridSize);
    const grid = new Uint8Array(gridW * gridH);

    for (let y = 0; y < h; y += step) {
        // Оптимизация: пропуск миникарты
        if (y > mapMinY) {
             // Если мы в зоне Y миникарты, сканируем только левую часть экрана
             for (let x = 0; x < mapMinX; x += step) {
                 checkPixel(x, y);
             }
        } else {
             // Иначе сканируем всю ширину
             for (let x = 0; x < w; x += step) {
                 checkPixel(x, y);
             }
        }
    }

    function checkPixel(x, y) {
        // Игнор центра
        const dx = x - cx, dy = y - cy;
        if (dx*dx + dy*dy < centerRadSq) return;

        // Проверка сетки занятости
        const gx = (x / gridSize) | 0;
        const gy = (y / gridSize) | 0;
        if (grid[gy * gridW + gx]) return;

        const idx = (y * w + x) * 4;
        // Префильтр (серый фон)
        if (Math.abs(data[idx] - data[idx+1]) < 20 && Math.abs(data[idx+1] - data[idx+2]) < 20) return;

        // Поиск цвета
        let match = null;
        const r = data[idx], g = data[idx+1], b = data[idx+2];
        for (const [key, t] of Object.entries(TARGETS)) {
            if (Math.abs(r - t.r) + Math.abs(g - t.g) + Math.abs(b - t.b) < CONFIG.tolerance * 3) {
                match = key; break;
            }
        }

        if (match) {
            const center = refineCenter(data, w, h, x, y, match);
            balls.push({ x: center.x, y: center.y, color: match });
            
            // Помечаем сетку
            const cgx = (center.x / gridSize) | 0;
            const cgy = (center.y / gridSize) | 0;
            // Помечаем 3x3 клетки вокруг, чтобы не детектить этот же шар
            for(let ly = cgy-1; ly <= cgy+1; ly++) {
                for(let lx = cgx-1; lx <= cgx+1; lx++) {
                    if(lx >=0 && lx < gridW && ly >=0 && ly < gridH) grid[ly * gridW + lx] = 1;
                }
            }
        }
    }
    return balls;
}

function refineCenter(data, w, h, startX, startY, colorKey) {
    let sumX = 0, sumY = 0, count = 0;
    const target = TARGETS[colorKey];
    const rLim = CONFIG.refineRadius;
    
    for (let y = startY - rLim; y <= startY + rLim; y += 2) {
        if (y < 0 || y >= h) continue;
        for (let x = startX - rLim; x <= startX + rLim; x += 2) {
            if (x < 0 || x >= w) continue;
            const i = (y * w + x) * 4;
            const dist = Math.abs(data[i] - target.r) + Math.abs(data[i+1] - target.g) + Math.abs(data[i+2] - target.b);
            if (dist < CONFIG.tolerance * 3) {
                sumX += x; sumY += y; count++;
            }
        }
    }
    return count > 0 ? { x: sumX/count, y: sumY/count } : { x: startX, y: startY };
}

function updateTrajectories(balls) {
    // 1. Предиктивный апдейт
    for (let t of trajectories) {
        t.updated = false;
        
        // Используем последний известный вектор для предсказания зоны поиска
        let searchX = t.x + (t.lastVx || 0);
        let searchY = t.y + (t.lastVy || 0);
        
        let bestIdx = -1; 
        let bestDist = 60; // Радиус поиска

        for (let i = 0; i < balls.length; i++) {
            if (balls[i].color !== t.color) continue;
            const dist = Math.hypot(balls[i].x - searchX, balls[i].y - searchY);
            if (dist < bestDist) { bestDist = dist; bestIdx = i; }
        }

        if (bestIdx !== -1) {
            const obj = balls[bestIdx];
            t.x = obj.x; 
            t.y = obj.y;
            t.points.push({ x: obj.x, y: obj.y, time: Date.now() });
            
            // Ограничиваем историю точек для регрессии
            if (t.points.length > 20) t.points.shift();
            
            t.updated = true;
            balls.splice(bestIdx, 1);
        }
    }

    // 2. Новые
    for (let b of balls) {
        trajectories.push({
            id: nextId++,
            color: b.color,
            x: b.x, y: b.y,
            lastVx: 0, lastVy: 0,
            points: [{ x: b.x, y: b.y, time: Date.now() }],
            updated: true
        });
    }
    
    // 3. Удаление мертвых
    trajectories = trajectories.filter(t => t.updated);
}

// --- ЛИНЕЙНАЯ РЕГРЕССИЯ (СУТЬ v8) ---
// Находит лучший вектор движения по облаку точек
function calculateTrend(points) {
    const len = points.length;
    if (len < CONFIG.minPointsForFix) return null;

    // Берем последние N точек
    const subset = points.slice(-CONFIG.fitLength);
    const n = subset.length;
    
    // Регрессия: x = at + b (позиция от времени, где a = скорость)
    // Но для простоты в игре с фиксированным FPS, мы можем считать индекс как время.
    // x = velocity_x * index + start_x
    
    let sumT = 0, sumX = 0, sumY = 0;
    let sumTX = 0, sumTY = 0, sumT2 = 0;

    for (let i = 0; i < n; i++) {
        // T - это просто порядковый номер, 0, 1, 2...
        // Это делает расчет независимым от скачков лага браузера
        const t = i; 
        const p = subset[i];
        
        sumT += t;
        sumT2 += t * t;
        sumX += p.x;
        sumY += p.y;
        sumTX += t * p.x;
        sumTY += t * p.y;
    }

    const den = (n * sumT2 - sumT * sumT);
    if (den === 0) return null;

    const vx = (n * sumTX - sumT * sumX) / den;
    const vy = (n * sumTY - sumT * sumY) / den;

    return { vx, vy };
}

function getGridShift(data, w, h) {
    const midY = (h/2)|0; const midX = (w/2)|0;
    // Увеличенный радиус поиска сетки
    const range = 150; 
    
    let bestX = -1, minLum = 255;
    const rowOffset = midY * w * 4;
    for (let x = midX - range; x < midX + range; x++) {
        const i = rowOffset + x * 4;
        const lum = data[i]; // Можно брать только красный канал для скорости, он в сером такой же
        if (lum < 205 && lum < minLum) { minLum = lum; bestX = x; }
    }
    
    let bestY = -1; minLum = 255;
    for (let y = midY - range; y < midY + range; y++) {
        const i = (y * w + midX) * 4;
        const lum = data[i];
        if (lum < 205 && lum < minLum) { minLum = lum; bestY = y; }
    }

    let res = { shifted: false, dx: 0, dy: 0 };
    if (bestX !== -1 && bestY !== -1) {
        if (gridState.valid) {
            const dx = bestX - gridState.lastX;
            const dy = bestY - gridState.lastY;
            // Увеличил лимит прыжка до 40, чтобы не терять сетку при быстром стрейфе
            if (Math.abs(dx) < 40 && Math.abs(dy) < 40 && (dx !== 0 || dy !== 0)) {
                res.dx = dx; res.dy = dy; res.shifted = true;
            }
        }
        gridState.lastX = bestX; gridState.lastY = bestY; gridState.valid = true;
    }
    return res;
}

function drawOverlay(ctx) {
    ctx.save();
    ctx.lineWidth = CONFIG.lineWidth;
    
    for (let t of trajectories) {
        if (t.points.length < 2) continue;
        const color = TARGETS[t.color].hex;
        ctx.strokeStyle = color;
        ctx.fillStyle = color;

        // Рисуем хвост (историю)
        ctx.beginPath();
        // Рисуем только последние точки, чтобы не захламлять
        const startIdx = Math.max(0, t.points.length - 10);
        ctx.moveTo(t.points[startIdx].x, t.points[startIdx].y);
        for (let i = startIdx + 1; i < t.points.length; i++) {
            ctx.lineTo(t.points[i].x, t.points[i].y);
        }
        ctx.stroke();

        // Считаем умный вектор
        const trend = calculateTrend(t.points);
        if (trend) {
            const speed = Math.hypot(trend.vx, trend.vy);
            t.lastVx = trend.vx; // Сохраняем для предикта
            t.lastVy = trend.vy;

            // Рисуем прогноз, только если объект реально летит
            if (speed > 1.0) {
                // Нормализация
                const dirX = trend.vx / speed;
                const dirY = trend.vy / speed;
                
                const head = t.points[t.points.length - 1];
                
                // ЛУЧ НАЗАД (Источник)
                ctx.beginPath();
                ctx.setLineDash([10, 10]); // Редкий пунктир
                ctx.globalAlpha = 0.6;
                ctx.moveTo(head.x, head.y);
                // Рисуем длинную прямую линию назад, ИГНОРИРУЯ мелкие колебания хвоста
                ctx.lineTo(head.x - dirX * CONFIG.predictionLen, head.y - dirY * CONFIG.predictionLen);
                ctx.stroke();
                
                ctx.setLineDash([]);
                ctx.globalAlpha = 1.0;
            }
        }
    }
    ctx.restore();
}

initTracker();