console.log('[DiepTracker] v2: Vision Test Loaded');

// Константы цветов из анализа DeepSeek
// Красный шар: (241, 78, 84)
const TARGET_COLOR = { r: 241, g: 78, b: 84 };
const TOLERANCE = 15; // Чуть больше допуска для начала, чтобы точно поймать

function initTracker() {
    const canvas = document.getElementById('canvas'); 
    
    if (!canvas) {
        setTimeout(initTracker, 500);
        return;
    }

    // Получаем контекст один раз
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    
    // Врезаемся в цикл отрисовки (ИСПРАВЛЕННАЯ ВЕРСИЯ)
    const originalRequestAnimationFrame = window.requestAnimationFrame;

    window.requestAnimationFrame = function(callback) {
        // Мы должны возвращать ID, чтобы игра не ломалась
        return originalRequestAnimationFrame(function(timestamp) {
            
            // 1. Даем игре отрисовать свой кадр
            if (typeof callback === 'function') {
                callback(timestamp);
            }

            // 2. НАША РАБОТА (Анализ и отрисовка)
            if (ctx) {
                processFrame(ctx, canvas);
            }
        });
    };
}

function processFrame(ctx, width, height) {
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;

    // --- ЭТАП АНАЛИЗА ---
    // Получаем массив всех пикселей экрана
    // Внимание: это тяжелая операция!
    const imageData = ctx.getImageData(0, 0, w, h);
    const data = imageData.data;

    // Будем рисовать поверх найденных пикселей
    // Но чтобы не создавать новый ImageData, просто нарисуем точки вектором поверх
    // Для теста производительности сканируем с шагом 4 (каждый 4-й пиксель)
    const step = 4; 
    
    ctx.save();
    ctx.fillStyle = '#00FF00'; // Зеленая подсветка

    // Проходим по пикселям
    // y += step, x += step для ускорения
    for (let y = 0; y < h; y += step) {
        for (let x = 0; x < w; x += step) {
            const index = (y * w + x) * 4;
            
            const r = data[index];
            const g = data[index + 1];
            const b = data[index + 2];

            // Простая проверка цвета (расстояние Манхэттена для скорости)
            // |R - TargetR| + |G - TargetG| + |B - TargetB| < Tolerance * 3
            if (Math.abs(r - TARGET_COLOR.r) < TOLERANCE &&
                Math.abs(g - TARGET_COLOR.g) < TOLERANCE &&
                Math.abs(b - TARGET_COLOR.b) < TOLERANCE) {
                
                // Если нашли похожий цвет - ставим точку
                ctx.fillRect(x, y, 2, 2); 
            }
        }
    }
    
    // Инфо-панель слева сверху
    ctx.fillStyle = 'black';
    ctx.fillRect(10, 10, 200, 30);
    ctx.fillStyle = 'white';
    ctx.font = '16px monospace';
    ctx.fillText("SCANNING: RED OBJECTS", 20, 30);

    ctx.restore();
}

initTracker();