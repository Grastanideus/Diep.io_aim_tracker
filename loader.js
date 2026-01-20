// loader.js
const script = document.createElement('script');
script.src = chrome.runtime.getURL('tracker.js');
script.onload = function() {
    this.remove(); // Удаляем тег <script> после загрузки, чтобы не мусорить
};
(document.head || document.documentElement).appendChild(script);
console.log('[DiepTracker] Инжектор сработал, скрипт загружается...');