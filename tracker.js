console.log('[DiepTracker] v9: Optical Flow Locking & Quality Filter');

const CONFIG = {
    // СКАНИРОВАНИЕ
    scanStep: 8,
    refineRadius: 15,
    
    // ФИЛЬТРЫ
    ignoreMinimap: 200,
    ignoreCenter: 65,
    tolerance: 15,
    
    // СТАБИЛИЗАЦИЯ (Оптический поток)
    lockRange: 30,         // Искать сдвиг фона в пределах +/- 30 пикселей
    
    // АНАЛИЗ ТРАЕКТОРИИ
    historyLen: 20,        // Длина памяти для расчета угла (чем больше, тем стабильнее)
    minLinearity: 0.95,    // 1.0 = идеальная прямая. Если ниже 0.95 - не рисуем пунктир (фильтр "пьяных" пуль)
    minSpeed: 2.0,
    
    // ВИЗУАЛ
    predictionLen: 800,
    lineWidth: 2
};

const TARGETS = {
    red:    { r: 241, g: 78,  b: 84,  hex: '#FF3333' },
    blue:   { r: 0,   g: 176, b: 225, hex: '#33BBFF' },
    purple: { r: 191, g: 127, b: 245, hex: '#CC66FF' },
    green:  { r: 0,   g: 225, b: 110, hex: '#00FF66' }
};

let trajectories = [];
let nextId = 1;

// Для оптического потока храним предыдущие строки пикселей
let prevRow = null; // Horizontal strip
let prevCol = null; // Vertical strip

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

    // --- 1. ОПТИЧЕСКИЙ ПОТОК (СУПЕР ТОЧНЫЙ СДВИГ ФОНА) ---
    // Берем крестовину пикселей через центр экрана
    const midX = (w/2)|0;
    const midY = (h/2)|0;
    // Длина полосы анализа (достаточно 200px в центре)
    const scanLen = 300; 
    
    // Извлекаем текущие полосы яркости (Luma)
    const currRow = new Uint8Array(scanLen);
    const currCol = new Uint8Array(scanLen);
    
    // Заполняем X полосу
    let ptr = 0;
    for (let x = midX - scanLen/2; x < midX + scanLen/2; x++) {
        const i = (midY * w + x) * 4;
        currRow[ptr++] = data[i]; // Берем только Red канал, для скорости (в ч/б сетке этого достаточно)
    }
    
    // Заполняем Y полосу
    ptr = 0;
    for (let y = midY - scanLen/2; y < midY + scanLen/2; y++) {
        const i = (y * w + midX) * 4;
        currCol[ptr++] = data[i];
    }

    // Считаем сдвиг относительно прошлого кадра
    const shift = calculateOpticalShift(currRow, currCol, prevRow, prevCol, scanLen);
    
    // Сохраняем текущие полосы как "прошлые" для следующего кадра
    prevRow = currRow;
    prevCol = currCol;

    // Применяем сдвиг к траекториям (ОБРАТНАЯ КОМПЕНСАЦИЯ)
    if (shift.valid) {
        for (let t of trajectories) {
            t.x -= shift.dx;
            t.y -= shift.dy;
            for (let p of t.points) {
                p.x -= shift.dx;
                p.y -= shift.dy;
            }
        }
    }

    // --- 2. ПОИСК ОБЪЕКТОВ ---
    const balls = findBalls(data, w, h);

    // --- 3. ТРЕКИНГ ---
    updateTrajectories(balls);

    // --- 4. ОТРИСОВКА ---
    drawOverlay(ctx);
}

// Алгоритм сопоставления шаблонов (Template Matching) 1D
function calculateOpticalShift(row, col, oldRow, oldCol, len) {
    if (!oldRow || !oldCol) return { dx: 0, dy: 0, valid: false };

    const searchRange = CONFIG.lockRange;
    
    // Поиск смещения по X
    let bestDx = 0;
    let minErrX = Infinity;
    
    // Пробуем сдвигать старый массив от -Range до +Range и ищем совпадение
    for (let offset = -searchRange; offset <= searchRange; offset++) {
        let err = 0;
        // Сравниваем центр массива (чтобы не вылететь за границы при сдвиге)
        // Сравниваем область 100 пикселей
        for (let i = 50; i < len - 50; i++) {
            const diff = row[i] - oldRow[i - offset];
            err += Math.abs(diff);
        }
        if (err < minErrX) { minErrX = err; bestDx = offset; }
    }

    // Поиск смещения по Y
    let bestDy = 0;
    let minErrY = Infinity;
    
    for (let offset = -searchRange; offset <= searchRange; offset++) {
        let err = 0;
        for (let i = 50; i < len - 50; i++) {
            const diff = col[i] - oldCol[i - offset];
            err += Math.abs(diff);
        }
        if (err < minErrY) { minErrY = err; bestDy = offset; }
    }

    // Если ошибка слишком велика, значит фон изменился полностью (смена сцены?), игнорируем
    // Но для дип.ио фон однородный, так что это редкость.
    return { dx: bestDx, dy: bestDy, valid: true };
}

function findBalls(data, w, h) {
    const balls = [];
    const step = CONFIG.scanStep;
    const cx = w/2, cy = h/2;
    const cRadSq = CONFIG.ignoreCenter**2;
    const mapMinX = w - CONFIG.ignoreMinimap, mapMinY = h - CONFIG.ignoreMinimap;
    const gridSize = 40; 
    const gridW = Math.ceil(w/gridSize), gridH = Math.ceil(h/gridSize);
    const grid = new Uint8Array(gridW*gridH);

    for (let y=0; y<h; y+=step) {
        if(y>mapMinY) { for(let x=0; x<mapMinX; x+=step) check(x,y); }
        else { for(let x=0; x<w; x+=step) check(x,y); }
    }

    function check(x, y) {
        if ((x-cx)**2 + (y-cy)**2 < cRadSq) return;
        const gx = (x/gridSize)|0, gy = (y/gridSize)|0;
        if (grid[gy*gridW+gx]) return;

        const idx = (y*w+x)*4;
        if (Math.abs(data[idx]-data[idx+1]) < 20 && Math.abs(data[idx+1]-data[idx+2]) < 20) return;

        let match = null;
        const r = data[idx], g = data[idx+1], b = data[idx+2];
        for (const k in TARGETS) {
            const t = TARGETS[k];
            if (Math.abs(r-t.r)+Math.abs(g-t.g)+Math.abs(b-t.b) < CONFIG.tolerance*3) { match = k; break; }
        }

        if (match) {
            const c = refineCenter(data, w, h, x, y, match);
            balls.push({x: c.x, y: c.y, color: match});
            for(let ly=gy-1; ly<=gy+1; ly++) 
                for(let lx=gx-1; lx<=gx+1; lx++) 
                    if(lx>=0 && lx<gridW && ly>=0 && ly<gridH) grid[ly*gridW+lx]=1;
        }
    }
    return balls;
}

function refineCenter(data, w, h, startX, startY, colorKey) {
    let sx=0, sy=0, c=0;
    const t = TARGETS[colorKey], lim = CONFIG.refineRadius;
    for(let y=startY-lim; y<=startY+lim; y+=2) {
        if(y<0||y>=h) continue;
        for(let x=startX-lim; x<=startX+lim; x+=2) {
            if(x<0||x>=w) continue;
            const i=(y*w+x)*4;
            if(Math.abs(data[i]-t.r)+Math.abs(data[i+1]-t.g)+Math.abs(data[i+2]-t.b) < CONFIG.tolerance*3) {
                sx+=x; sy+=y; c++;
            }
        }
    }
    return c>0 ? {x: sx/c, y: sy/c} : {x: startX, y: startY};
}

function updateTrajectories(balls) {
    for (let t of trajectories) {
        t.updated = false;
        // Простой линейный предикт для ассоциации
        let predX = t.x, predY = t.y;
        if(t.points.length > 1) {
            predX += (t.points[t.points.length-1].x - t.points[t.points.length-2].x);
            predY += (t.points[t.points.length-1].y - t.points[t.points.length-2].y);
        }

        let bestIdx = -1, bestDist = 60;
        for(let i=0; i<balls.length; i++) {
            if(balls[i].color !== t.color) continue;
            const dist = Math.hypot(balls[i].x - predX, balls[i].y - predY);
            if(dist < bestDist) { bestDist = dist; bestIdx = i; }
        }

        if(bestIdx !== -1) {
            const b = balls[bestIdx];
            t.x = b.x; t.y = b.y;
            t.points.push({x: b.x, y: b.y});
            if(t.points.length > CONFIG.historyLen) t.points.shift();
            t.updated = true;
            balls.splice(bestIdx, 1);
        }
    }
    for(let b of balls) {
        trajectories.push({
            id: nextId++, color: b.color, x: b.x, y: b.y,
            points: [{x: b.x, y: b.y}], updated: true
        });
    }
    trajectories = trajectories.filter(t => t.updated);
}

// Расчет регрессии и качества линии (R-squared approximation)
function getTrend(points) {
    if(points.length < 5) return null;
    const n = points.length;
    let sumX=0, sumY=0, sumT=0, sumT2=0, sumTX=0, sumTY=0;
    
    for(let i=0; i<n; i++) {
        sumX += points[i].x; sumY += points[i].y;
        sumT += i; sumT2 += i*i;
        sumTX += i*points[i].x; sumTY += i*points[i].y;
    }
    
    const den = n*sumT2 - sumT*sumT;
    if(den === 0) return null;
    
    const vx = (n*sumTX - sumT*sumX) / den;
    const vy = (n*sumTY - sumT*sumY) / den;
    
    // Проверка качества (ошибка)
    let error = 0;
    const startX = (sumX - vx*sumT)/n;
    const startY = (sumY - vy*sumT)/n;
    
    for(let i=0; i<n; i++) {
        const idealX = startX + vx*i;
        const idealY = startY + vy*i;
        const dx = points[i].x - idealX;
        const dy = points[i].y - idealY;
        error += Math.sqrt(dx*dx + dy*dy);
    }
    const avgError = error / n;

    return { vx, vy, error: avgError };
}

function drawOverlay(ctx) {
    ctx.save();
    ctx.lineWidth = CONFIG.lineWidth;
    
    for (let t of trajectories) {
        if (t.points.length < 3) continue;
        const color = TARGETS[t.color].hex;
        ctx.strokeStyle = color; 
        
        // Линия истории (сплошная)
        ctx.beginPath();
        const start = Math.max(0, t.points.length-10);
        ctx.moveTo(t.points[start].x, t.points[start].y);
        for(let i=start+1; i<t.points.length; i++) ctx.lineTo(t.points[i].x, t.points[i].y);
        ctx.stroke();

        // Анализ вектора
        const trend = getTrend(t.points);
        
        // Рисуем пунктир ТОЛЬКО если ошибка линии мала (< 2.0 пикселей в среднем)
        // Это уберет дергающиеся линии
        if(trend && trend.error < 2.0) {
            const speed = Math.hypot(trend.vx, trend.vy);
            if(speed > CONFIG.minSpeed) {
                const head = t.points[t.points.length-1];
                const dx = trend.vx / speed;
                const dy = trend.vy / speed;
                
                ctx.beginPath();
                ctx.setLineDash([15, 10]); // Длинный штрих
                ctx.globalAlpha = 0.5;
                ctx.moveTo(head.x, head.y);
                ctx.lineTo(head.x - dx*CONFIG.predictionLen, head.y - dy*CONFIG.predictionLen);
                ctx.stroke();
                ctx.globalAlpha = 1.0;
                ctx.setLineDash([]);
            }
        }
    }
    ctx.restore();
}

initTracker();