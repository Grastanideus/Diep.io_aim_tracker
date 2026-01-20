console.log('[DiepTracker] v3: Multi-Color Trajectories Loaded');

// --- НАСТРОЙКИ ---
const CONFIG = {
    step: 5,               // Шаг сканирования (больше = быстрее, меньше = точнее)
    tolerance: 15,         // Допуск по цвету
    minClusterSize: 5,     // Минимум точек, чтобы считать это объектом (фильтр шума)
    clusterDist: 40,       // Макс расстояние между точками одного объекта
    trailLength: 20        // Длина хвоста траектории
};

// Цвета целей (RGB)
const TARGETS = {
    red:    { r: 241, g: 78,  b: 84,  hex: '#FF0000' },
    blue:   { r: 0,   g: 176, b: 225, hex: '#00B0E1' },
    green:  { r: 0,   g: 225, b: 110, hex: '#00E16E' },
    purple: { r: 191, g: 127, b: 245, hex: '#BF7FF5' }
};

// Хранилище активных траекторий
// Формат: { id, color, points: [{x, y}, ...], lastUpdate: timestamp }
let trajectories = [];
let nextId = 1;

function initTracker() {
    const canvas = document.getElementById('canvas'); 
    if (!canvas) { setTimeout(initTracker, 500); return; }

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    
    // Перехват кадра
    const originalRequestAnimationFrame = window.requestAnimationFrame;
    window.requestAnimationFrame = function(callback) {
        return originalRequestAnimationFrame(function(timestamp) {
            if (typeof callback === 'function') callback(timestamp);
            if (ctx) processFrame(ctx);
        });
    };
}

function processFrame(ctx) {
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    
    // 1. ПОЛУЧЕНИЕ ДАННЫХ
    const imageData = ctx.getImageData(0, 0, w, h);
    const data = imageData.data;
    
    // Временное хранилище найденных сгустков (blobs) для текущего кадра
    // Структура: { xSum, ySum, count, colorKey, minX, maxX, minY, maxY }
    let blobs = [];

    // 2. СКАНИРОВАНИЕ И КЛАСТЕРИЗАЦИЯ (УПРОЩЕННАЯ)
    for (let y = 0; y < h; y += CONFIG.step) {
        for (let x = 0; x < w; x += CONFIG.step) {
            const i = (y * w + x) * 4;
            const r = data[i], g = data[i+1], b = data[i+2];

            // Проверяем совпадение с любым из цветов
            let matchedColor = null;
            for (const [key, color] of Object.entries(TARGETS)) {
                if (Math.abs(r - color.r) < CONFIG.tolerance &&
                    Math.abs(g - color.g) < CONFIG.tolerance &&
                    Math.abs(b - color.b) < CONFIG.tolerance) {
                    matchedColor = key;
                    break;
                }
            }

            if (matchedColor) {
                // Пытаемся добавить пиксель к существующему сгустку
                let foundBlob = false;
                for (let blob of blobs) {
                    // Если цвет совпадает и пиксель близко к центру сгустка (или его границам)
                    if (blob.colorKey === matchedColor) {
                        // Быстрая проверка расстояния до центра масс сгустка
                        const centerX = blob.xSum / blob.count;
                        const centerY = blob.ySum / blob.count;
                        const dist = Math.abs(x - centerX) + Math.abs(y - centerY); // Манхэттенское расстояние быстрее
                        
                        if (dist < CONFIG.clusterDist) {
                            blob.xSum += x;
                            blob.ySum += y;
                            blob.count++;
                            foundBlob = true;
                            break;
                        }
                    }
                }
                
                // Если не нашли куда приткнуть - создаем новый сгусток
                if (!foundBlob) {
                    blobs.push({ xSum: x, ySum: y, count: 1, colorKey: matchedColor });
                }
            }
        }
    }

    // 3. ПРЕВРАЩЕНИЕ СГУСТКОВ В КООРДИНАТЫ ШАРОВ
    const currentBalls = [];
    for (let blob of blobs) {
        if (blob.count >= CONFIG.minClusterSize) {
            currentBalls.push({
                x: blob.xSum / blob.count,
                y: blob.ySum / blob.count,
                color: blob.colorKey
            });
        }
    }

    // 4. ТРЕКИНГ (Сопоставление с прошлыми кадрами)
    updateTrajectories(currentBalls);

    // 5. ОТРИСОВКА
    drawOverlay(ctx);
}

function updateTrajectories(currentBalls) {
    // Для каждого существующего трека пытаемся найти продолжение
    for (let track of trajectories) {
        track.updated = false;
        
        // Ищем ближайший шар того же цвета
        let bestDist = 1000;
        let bestBallIndex = -1;

        for (let i = 0; i < currentBalls.length; i++) {
            const ball = currentBalls[i];
            if (ball.color !== track.color) continue;
            
            // Берем последнюю известную точку трека
            const lastPoint = track.points[track.points.length - 1];
            const dist = Math.hypot(ball.x - lastPoint.x, ball.y - lastPoint.y);

            // Если шар достаточно близко, считаем что это он же
            if (dist < 50 && dist < bestDist) {
                bestDist = dist;
                bestBallIndex = i;
            }
        }

        // Если нашли продолжение
        if (bestBallIndex !== -1) {
            const ball = currentBalls[bestBallIndex];
            track.points.push({ x: ball.x, y: ball.y });
            if (track.points.length > CONFIG.trailLength) track.points.shift(); // Удаляем старый хвост
            track.updated = true;
            // Удаляем шар из списка доступных, чтобы он не пошел в другой трек
            currentBalls.splice(bestBallIndex, 1);
        }
    }

    // Все шары, которые не нашли себе пару - это новые объекты
    for (let ball of currentBalls) {
        trajectories.push({
            id: nextId++,
            color: ball.color,
            points: [{ x: ball.x, y: ball.y }],
            updated: true
        });
    }

    // Удаляем треки, которые потеряли цель (не обновились в этом кадре)
    // Или можно дать им "жизнь" на пару кадров, но пока удаляем сразу для чистоты
    trajectories = trajectories.filter(t => t.updated);
}

function drawOverlay(ctx) {
    ctx.save();
    
    // Рисуем линии
    ctx.lineWidth = 2;
    for (let track of trajectories) {
        if (track.points.length < 2) continue;

        ctx.strokeStyle = TARGETS[track.color].hex; // Берем цвет из конфига
        ctx.beginPath();
        ctx.moveTo(track.points[0].x, track.points[0].y);
        for (let i = 1; i < track.points.length; i++) {
            ctx.lineTo(track.points[i].x, track.points[i].y);
        }
        ctx.stroke();

        // Рисуем кружок на голове (текущая позиция)
        const head = track.points[track.points.length - 1];
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(head.x - 2, head.y - 2, 4, 4);
    }

    // Инфо
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(10, 10, 150, 60);
    ctx.fillStyle = '#FFF';
    ctx.font = '12px monospace';
    ctx.fillText(`TRACKING ACTIVE`, 15, 25);
    ctx.fillText(`Objects: ${trajectories.length}`, 15, 40);
    ctx.fillText(`Colors: R/G/B/P`, 15, 55);

    ctx.restore();
}

initTracker();