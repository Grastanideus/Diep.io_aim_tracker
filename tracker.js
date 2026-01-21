console.log('[DiepTracker] v10: Auto-IFF & Source Triangulation');

const CONFIG = {
    // --- БАЗА ---
    scanStep: 8,
    refineRadius: 15,
    ignoreMinimap: 200,
    ignoreCenter: 60, // Радиус игнора центра (для трекинга, не для цвета)
    tolerance: 15,
    
    // --- ФИЗИКА ---
    historyLen: 20,
    minLinearity: 0.95,    // Только прямые линии (фильтр 3.0 пикселя ошибки)
    minSpeed: 2.0,
    
    // --- ЛОГИКА СВОЙ-ЧУЖОЙ ---
    iffInterval: 2000,     // Проверять свой цвет раз в 2 секунды
    
    // --- ТРИАНГУЛЯЦИЯ (ПОИСК ВРАГА) ---
    minConverging: 3,      // Минимум 3 линии должны сойтись, чтобы показать цель
    convergenceDist: 100,  // Радиус, в котором должны пересечься линии
    
    // --- ВИЗУАЛ ---
    predictionLen: 1000,
    lineWidth: 1.5
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

// Состояние игрока и цели
let playerState = {
    myColor: null,
    lastCheck: 0
};
let predictedTarget = null; // {x, y, strength}

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
    const now = Date.now();

    // 1. ОПРЕДЕЛЕНИЕ СВОЕГО ЦВЕТА (IFF)
    if (now - playerState.lastCheck > CONFIG.iffInterval) {
        detectPlayerColor(data, w, h);
        playerState.lastCheck = now;
    }

    // 2. КОРРЕКЦИЯ СЕТКИ (Optical Flow)
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
        // Сдвигаем и предсказанную цель
        if (predictedTarget) {
            predictedTarget.x -= gridMove.dx;
            predictedTarget.y -= gridMove.dy;
        }
    }

    // 3. ПОИСК ОБЪЕКТОВ (С фильтром "Свой-Чужой")
    const balls = findBalls(data, w, h);

    // 4. ОБНОВЛЕНИЕ ТРАЕКТОРИЙ
    updateTrajectories(balls);

    // 5. РАСЧЕТ ИСТОЧНИКА (ТРИАНГУЛЯЦИЯ)
    calculateSource();

    // 6. ОТРИСОВКА
    drawOverlay(ctx, w, h);
}

// Проверяем цвет в центре экрана (там всегда танк игрока)
function detectPlayerColor(data, w, h) {
    const cx = Math.floor(w / 2);
    const cy = Math.floor(h / 2);
    const radius = 30; // Смотрим в центре
    
    let counts = { red: 0, blue: 0, green: 0, purple: 0 };
    
    for (let y = cy - radius; y < cy + radius; y+=4) {
        for (let x = cx - radius; x < cx + radius; x+=4) {
            const i = (y * w + x) * 4;
            const r = data[i], g = data[i+1], b = data[i+2];
            
            for (const [key, t] of Object.entries(TARGETS)) {
                if (Math.abs(r - t.r) + Math.abs(g - t.g) + Math.abs(b - t.b) < CONFIG.tolerance * 2) {
                    counts[key]++;
                }
            }
        }
    }
    
    // Находим победителя
    let bestColor = null;
    let maxCount = 10; // Порог шума
    for (const [key, val] of Object.entries(counts)) {
        if (val > maxCount) {
            maxCount = val;
            bestColor = key;
        }
    }
    
    if (bestColor && bestColor !== playerState.myColor) {
        playerState.myColor = bestColor;
        // Очищаем старые траектории при смене цвета, чтобы не глючило
        trajectories = []; 
    }
}

function findBalls(data, w, h) {
    const balls = [];
    const step = CONFIG.scanStep;
    const cx = w/2, cy = h/2;
    const cRadSq = CONFIG.ignoreCenter**2;
    
    // Границы для миникарты
    const mapMinX = w - CONFIG.ignoreMinimap;
    const mapMinY = h - CONFIG.ignoreMinimap;

    // Сетка занятости
    const gs = 40; const gw = Math.ceil(w/gs); const gh = Math.ceil(h/gs);
    const grid = new Uint8Array(gw*gh);

    for (let y=0; y<h; y+=step) {
        // Оптимизация миникарты
        if(y>mapMinY) { for(let x=0; x<mapMinX; x+=step) check(x,y); }
        else { for(let x=0; x<w; x+=step) check(x,y); }
    }

    function check(x, y) {
        if ((x-cx)**2 + (y-cy)**2 < cRadSq) return;
        const gx=(x/gs)|0, gy=(y/gs)|0;
        if (grid[gy*gw+gx]) return;

        const idx = (y*w+x)*4;
        if (Math.abs(data[idx]-data[idx+1]) < 20) return; // Серый фильтр

        let match = null;
        const r = data[idx], g = data[idx+1], b = data[idx+2];
        for (const k in TARGETS) {
            // ИГНОРИРУЕМ СВОЙ ЦВЕТ
            if (k === playerState.myColor) continue;
            
            const t = TARGETS[k];
            if (Math.abs(r-t.r)+Math.abs(g-t.g)+Math.abs(b-t.b) < CONFIG.tolerance*3) { match = k; break; }
        }

        if (match) {
            const c = refineCenter(data, w, h, x, y, match);
            balls.push({x: c.x, y: c.y, color: match});
            // Mark grid
            for(let ly=gy-1; ly<=gy+1; ly++) 
                for(let lx=gx-1; lx<=gx+1; lx++) 
                    if(lx>=0 && lx<gw && ly>=0 && ly<gh) grid[ly*gw+lx]=1;
        }
    }
    return balls;
}

// ... (refineCenter и updateTrajectories остались теми же, что и в v8/v9, я их сжал для краткости) ...
function refineCenter(d,w,h,sx,sy,k){let X=0,Y=0,c=0,t=TARGETS[k],L=CONFIG.refineRadius;for(let y=sy-L;y<=sy+L;y+=2){if(y<0||y>=h)continue;for(let x=sx-L;x<=sx+L;x+=2){if(x<0||x>=w)continue;let i=(y*w+x)*4;if(Math.abs(d[i]-t.r)+Math.abs(d[i+1]-t.g)+Math.abs(d[i+2]-t.b)<45){X+=x;Y+=y;c++}}}return c?{x:X/c,y:Y/c}:{x:sx,y:sy}}
function updateTrajectories(b){for(let t of trajectories){t.ud=false;let px=t.x+(t.lvx||0),py=t.y+(t.lvy||0),bi=-1,bd=60;for(let i=0;i<b.length;i++){if(b[i].color!==t.color)continue;let d=Math.hypot(b[i].x-px,b[i].y-py);if(d<bd){bd=d;bi=i}}if(bi!==-1){t.x=b[bi].x;t.y=b[bi].y;t.points.push({x:t.x,y:t.y});if(t.points.length>25)t.points.shift();t.ud=true;b.splice(bi,1)}}for(let o of b){trajectories.push({id:nextId++,color:o.color,x:o.x,y:o.y,lvx:0,lvy:0,points:[{x:o.x,y:o.y}],ud:true})}trajectories=trajectories.filter(t=>t.ud);}

// ... (getTrend тоже старый, но нужен для расчетов) ...
function getTrend(p){if(p.length<5)return null;let n=p.length,sx=0,sy=0,st=0,st2=0,stx=0,sty=0;for(let i=0;i<n;i++){sx+=p[i].x;sy+=p[i].y;st+=i;st2+=i*i;stx+=i*p[i].x;sty+=i*p[i].y}let d=n*st2-st*st;if(d===0)return null;let vx=(n*stx-st*sx)/d,vy=(n*sty-st*sy)/d;let e=0,bx=(sx-vx*st)/n,by=(sy-vy*st)/n;for(let i=0;i<n;i++)e+=Math.hypot(p[i].x-(bx+vx*i),p[i].y-(by+vy*i));return{vx,vy,err:e/n}}

// --- ТРИАНГУЛЯЦИЯ ---
function calculateSource() {
    const lines = [];
    
    // 1. Собираем все качественные линии
    for (let t of trajectories) {
        if (t.points.length < 5) continue;
        const trend = getTrend(t.points);
        // Допуск ошибки 3 пикселя (чуть мягче, чем в v9)
        if (trend && trend.err < 3.0) {
            const speed = Math.hypot(trend.vx, trend.vy);
            if (speed > CONFIG.minSpeed) {
                // Нормализуем вектор (направлен ВПЕРЕД)
                const dx = trend.vx / speed;
                const dy = trend.vy / speed;
                const head = t.points[t.points.length-1];
                
                // Нам нужен луч НАЗАД: Head - t * Dir
                lines.push({ x: head.x, y: head.y, dx: -dx, dy: -dy });
            }
        }
    }

    if (lines.length < CONFIG.minConverging) {
        predictedTarget = null;
        return;
    }

    // 2. Ищем пересечения пар линий
    let intersections = [];
    
    for (let i = 0; i < lines.length; i++) {
        for (let j = i + 1; j < lines.length; j++) {
            const l1 = lines[i];
            const l2 = lines[j];
            
            // Если линии почти параллельны, пропускаем
            const dot = l1.dx * l2.dx + l1.dy * l2.dy;
            if (dot > 0.95 || dot < -0.95) continue; // Угол слишком мал

            // Находим точку пересечения двух лучей
            // P1 + t*V1 = P2 + u*V2
            // Это система линейных уравнений
            const det = l2.dx * l1.dy - l2.dy * l1.dx;
            if (det === 0) continue;
            
            const u = ((l1.x - l2.x) * l1.dy - (l1.y - l2.y) * l1.dx) / det;
            const t = ((l2.x - l1.x) * -l2.dy - (l2.y - l1.y) * -l2.dx) / det; // упрощенно

            // u - это расстояние от головы l2 до точки пересечения
            // Мы ищем источники, так что пересечение должно быть "впереди" по вектору (назад от пули)
            if (u > 0) {
                const ix = l2.x + u * l2.dx;
                const iy = l2.y + u * l2.dy;
                intersections.push({ x: ix, y: iy });
            }
        }
    }

    // 3. Кластеризация пересечений
    // Ищем место с максимальной плотностью точек
    let bestCluster = null;
    let maxDensity = 0;

    for (let i = 0; i < intersections.length; i++) {
        let count = 0;
        let sx = 0, sy = 0;
        
        for (let j = 0; j < intersections.length; j++) {
            const dist = Math.hypot(intersections[i].x - intersections[j].x, intersections[i].y - intersections[j].y);
            if (dist < CONFIG.convergenceDist) {
                count++;
                sx += intersections[j].x;
                sy += intersections[j].y;
            }
        }

        if (count >= Math.max(3, CONFIG.minConverging * (lines.length/4))) { // Адаптивный порог
            if (count > maxDensity) {
                maxDensity = count;
                bestCluster = { x: sx/count, y: sy/count, strength: count };
            }
        }
    }

    predictedTarget = bestCluster;
}

// ... (getGridShift старый) ...
function getGridShift(d,w,h){const my=(h/2)|0,mx=(w/2)|0,R=150;let bx=-1,ml=255,ro=my*w*4;for(let x=mx-R;x<mx+R;x++){let l=d[ro+x*4];if(l<205&&l<ml){ml=l;bx=x}}let by=-1;ml=255;for(let y=my-R;y<my+R;y++){let l=d[(y*w+mx)*4];if(l<205&&l<ml){ml=l;by=y}}let r={shifted:false,dx:0,dy:0};if(bx!==-1&&by!==-1){if(gridState.valid){let dx=bx-gridState.lastX,dy=by-gridState.lastY;if(Math.abs(dx)<40&&Math.abs(dy)<40&&(dx||dy)){r.dx=dx;r.dy=dy;r.shifted=true}}gridState.lastX=bx;gridState.lastY=by;gridState.valid=true}return r}

function drawOverlay(ctx, w, h) {
    ctx.save();
    
    // Рисуем Траектории
    for (let t of trajectories) {
        if (t.points.length < 2) continue;
        const trend = getTrend(t.points);
        const color = TARGETS[t.color].hex;
        
        ctx.strokeStyle = color;
        ctx.lineWidth = CONFIG.lineWidth;
        
        // Хвост
        ctx.beginPath();
        const s = Math.max(0, t.points.length-10);
        ctx.moveTo(t.points[s].x, t.points[s].y);
        for(let i=s+1;i<t.points.length;i++) ctx.lineTo(t.points[i].x,t.points[i].y);
        ctx.stroke();

        // Пунктир назад (только если линия качественная)
        if (trend && trend.err < 3.0 && Math.hypot(trend.vx, trend.vy) > CONFIG.minSpeed) {
            const head = t.points[t.points.length-1];
            const sp = Math.hypot(trend.vx, trend.vy);
            
            ctx.beginPath();
            ctx.setLineDash([5, 15]); // Очень редкий пунктир, чтобы не мешал
            ctx.globalAlpha = 0.3;
            ctx.moveTo(head.x, head.y);
            ctx.lineTo(head.x - (trend.vx/sp)*800, head.y - (trend.vy/sp)*800);
            ctx.stroke();
            ctx.globalAlpha = 1.0;
            ctx.setLineDash([]);
        }
    }

    // Рисуем ЦЕЛЬ (TARGET LOCK)
    if (predictedTarget) {
        const tx = predictedTarget.x;
        const ty = predictedTarget.y;
        
        // Линия от игрока к цели
        ctx.beginPath();
        ctx.strokeStyle = '#FF0000';
        ctx.lineWidth = 1;
        ctx.moveTo(w/2, h/2);
        ctx.lineTo(tx, ty);
        ctx.stroke();

        // Прицел
        ctx.strokeStyle = '#FF0000';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(tx, ty, 20, 0, Math.PI * 2); // Круг
        ctx.stroke();
        
        // Крестик
        ctx.beginPath();
        ctx.moveTo(tx - 30, ty); ctx.lineTo(tx + 30, ty);
        ctx.moveTo(tx, ty - 30); ctx.lineTo(tx, ty + 30);
        ctx.stroke();

        // Текст расстояния
        const dist = Math.floor(Math.hypot(tx - w/2, ty - h/2));
        ctx.fillStyle = 'red';
        ctx.font = 'bold 20px Arial';
        ctx.fillText(`TARGET ${dist}px`, tx + 25, ty - 25);
    }

    // Инфо панель
    ctx.fillStyle = 'black';
    ctx.font = '12px monospace';
    // ctx.fillText(`My Color: ${playerState.myColor || 'Detecting...'}`, 10, 20);

    ctx.restore();
}

initTracker();